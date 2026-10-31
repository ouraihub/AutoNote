use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use aether_observability::LogConfig;
use aether_providers::Store as ProviderStore;
use note_core::{Error, Library, LibraryDeps, RandomIds, SystemClock};

use crate::{events, AppContext, AetherHost, LazyChatStore};
pub(crate) fn open_context(
    data_dir: PathBuf,
    sink: Arc<events::TauriChangeSink>,
    logs: aether_observability::LogHandle,
    providers: Arc<ProviderStore>,
) -> Result<AppContext, Error> {
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "AutoNote starting");
    let library = Library::open_with_deps(
        &autonote_shell::paths::library_db(&data_dir),
        LibraryDeps {
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds),
            sink: sink.clone(),
        },
    )?;
    let library = Arc::new(library);
    let sync = note_sync::SyncService::new(
        library.clone(),
        Arc::new(autonote_shell::credentials::PlatformSecretStore),
        sink.clone(),
    )
    .map_err(|_| Error::invalid("startup", "Sync service unavailable"))?;
    sink.bind_sync(&sync);
    Ok(AppContext {
        data_dir,
        library,
        jobs: Arc::default(),
        sync,
        logs,
        providers,
    })
}

/// Starts the desktop application.
pub fn run() {
    let sink = Arc::new(events::TauriChangeSink::default());
    let data_dir = autonote_shell::paths::data_dir().unwrap_or_else(|error| {
        eprintln!("AutoNote could not start: {error}");
        std::process::exit(1);
    });
    if let Err(error) = autonote_shell::paths::prepare_data_dir(&data_dir) {
        eprintln!("AutoNote could not start: {error}");
        return;
    }
    let logs = match aether_observability::init(&data_dir.join("logs"), LogConfig::default(), None)
    {
        Ok(logs) => logs,
        Err(_) => {
            eprintln!("AutoNote could not start: Aether logging unavailable");
            return;
        }
    };
    let providers = match ProviderStore::open(&data_dir) {
        Ok(store) => Arc::new(store),
        Err(_) => {
            eprintln!("AutoNote could not start: provider store unavailable");
            return;
        }
    };
    let search = match aether_search::Store::open(
        &data_dir.join("search-config.db"),
        aether_runtime::AddressPolicy::default(),
    ) {
        Ok(store) => Arc::new(store),
        Err(_) => {
            eprintln!("AutoNote could not start: search store unavailable");
            return;
        }
    };
    let skills = match aether_skills::Store::open(&data_dir, aether_skills::creator::CREATOR_SKILLS)
    {
        Ok(store) => Arc::new(store),
        Err(_) => {
            eprintln!("AutoNote could not start: skills store unavailable");
            return;
        }
    };
    let mcp_client = match aether_mcp_client::Store::open(&data_dir) {
        Ok(store) => Arc::new(aether_mcp_client::McpRuntime::new(Arc::new(store))),
        Err(_) => {
            eprintln!("AutoNote could not start: MCP client store unavailable");
            return;
        }
    };
    let host_library = Arc::new(OnceLock::new());
    let chat_store: Arc<LazyChatStore> = Arc::new(LazyChatStore {
        root: data_dir.clone(),
        store: std::sync::Mutex::new(None),
        writing: std::sync::atomic::AtomicU64::new(0),
    });
    let host = Arc::new(AetherHost {
        library: host_library.clone(),
        providers: providers.clone(),
        chat_store: chat_store.clone(),
        skills: crate::skill_runner::SkillRunner::new(skills.clone(), data_dir.clone()),
    });
    let settings: autonote_shell::desktop_prefs::McpHostSettings =
        autonote_shell::desktop_prefs::load(&autonote_shell::paths::mcp_settings_file(&data_dir))
            .unwrap_or_default();
    let aether_server = match aether_mcp_server::McpServer::new(
        &data_dir,
        aether_mcp_server::ServerConfig {
            default_port: settings.port,
            token_prefix: "autonote",
        },
        note_mcp::SCOPES.to_vec(),
        note_mcp::exposed_tools(host_library.clone()),
    ) {
        Ok(server) => server,
        Err(_) => {
            eprintln!("AutoNote could not start: MCP server unavailable");
            return;
        }
    };
    if note_mcp::enable_read_baseline(&aether_server).is_err() {
        eprintln!("AutoNote could not start: MCP server unavailable");
        return;
    }
    let conversations = Arc::new(aether_runtime::conversations::ConversationService::new(
        chat_store.clone(),
    ));
    let mut deps = aether_runtime::RunDependencies::new(providers.clone());
    deps.conversations = Some(chat_store);
    deps.skills = Some(skills.clone());
    deps.search = Some(search.clone());
    deps.mcp = Some(mcp_client.clone());
    let runs = match tauri::async_runtime::block_on(async {
        aether_runtime::RunService::new(
            host,
            aether_runtime::RunConfig::default(),
            deps,
            aether_runtime::AddressPolicy::default(),
        )
    }) {
        Ok(runs) => runs,
        Err(_) => {
            eprintln!("AutoNote could not start: Aether runtime unavailable");
            return;
        }
    };
    let skill_authoring = match tauri::async_runtime::block_on(async {
        aether_runtime::SkillAuthoringService::new(
            providers.clone(),
            skills.clone(),
            aether_runtime::AddressPolicy::default(),
        )
    }) {
        Ok(service) => service,
        Err(_) => {
            tauri::async_runtime::block_on(async {
                runs.shutdown(std::time::Duration::from_secs(3)).await;
                mcp_client.shutdown().await;
            });
            eprintln!("AutoNote could not start: skill authoring unavailable");
            return;
        }
    };
    let aether = match tauri_plugin_aether::Builder::new(logs.clone())
        .providers(providers.clone())
        .search(search)
        .runs(runs.clone())
        .conversations(conversations)
        .mcp_server(aether_server)
        .skills(skills)
        .skill_authoring(skill_authoring)
        .mcp_client(mcp_client.clone())
        .build()
    {
        Ok(plugin) => plugin,
        Err(_) => {
            tauri::async_runtime::block_on(async {
                runs.shutdown(std::time::Duration::from_secs(3)).await;
                mcp_client.shutdown().await;
            });
            eprintln!("AutoNote could not start: Aether unavailable");
            return;
        }
    };
    let application = crate::application::build(
        aether,
        data_dir,
        sink,
        logs,
        providers,
        host_library,
        settings,
        runs.clone(),
        mcp_client.clone(),
    );
    match application {
        Ok(app) => app.run(|handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && !handle
                    .state::<crate::window::DesktopState>()
                    .allow_exit
                    .load(std::sync::atomic::Ordering::Acquire)
            {
                api.prevent_exit();
                crate::window::request_close(handle, true);
            }
        }),
        Err(error) => {
            tauri::async_runtime::block_on(async {
                runs.shutdown(std::time::Duration::from_secs(3)).await;
                mcp_client.shutdown().await;
            });
            tracing::error!(code = "internal", stage = "startup", "app.lifecycle.start_failed");
            eprintln!(
                "AutoNote could not start. Move the application folder to a writable location. {error}"
            );
        }
    }
}
