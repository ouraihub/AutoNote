//! Model type and capability inference from the model id (doc 23 §4).

use note_core::ai::{AiModel, AiModelType, AiProtocol, AiTypeSource};

const CHAT_FAMILIES: [&str; 8] = [
    "claude", "gpt", "gemini", "deepseek", "qwen", "glm", "kimi", "moonshot",
];

/// Infers type, context window and vision support for `model_id`.
/// The result is marked [`AiTypeSource::Inferred`].
#[must_use]
pub fn infer(model_id: &str, protocol: AiProtocol) -> AiModel {
    let id = model_id.to_lowercase();
    let model_type = model_type(&id);
    let (context_window, can_vision) = match (model_type, family(&id)) {
        (AiModelType::Chat, Some("claude")) => {
            (Some(200_000), protocol == AiProtocol::AnthropicMessages)
        }
        (AiModelType::Chat, Some("gpt")) => (Some(400_000), true),
        (AiModelType::Chat, Some("gemini")) => (Some(1_000_000), true),
        (AiModelType::Chat, _) => (Some(128_000), false),
        _ => (None, false),
    };
    AiModel {
        id: model_id.to_owned(),
        model_type,
        type_source: AiTypeSource::Inferred,
        context_window,
        can_vision,
    }
}

/// Display group for probe results: the model family prefix, else `other`.
#[must_use]
pub fn group_of(model_id: &str) -> Option<String> {
    Some(
        family(&model_id.to_lowercase())
            .unwrap_or("other")
            .to_owned(),
    )
}

fn model_type(id: &str) -> AiModelType {
    let has = |needles: &[&str]| needles.iter().any(|needle| id.contains(needle));
    if has(&["rerank"]) {
        AiModelType::Rerank
    } else if has(&["embed"]) || id.starts_with("bge-") || id.starts_with("voyage-") {
        AiModelType::Embedding
    } else if has(&["whisper", "transcri"]) {
        AiModelType::Stt
    } else if has(&["tts"]) {
        AiModelType::Tts
    } else if has(&["veo", "sora", "video"]) {
        AiModelType::Video
    } else if has(&["dall-e", "image", "imagen"]) {
        AiModelType::Image
    } else if family(id).is_some() {
        AiModelType::Chat
    } else {
        AiModelType::Unknown
    }
}

/// Chat family of a lowercased id; `o` + digit belongs to `gpt`.
fn family(id: &str) -> Option<&'static str> {
    if id
        .strip_prefix('o')
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
    {
        return Some("gpt");
    }
    CHAT_FAMILIES
        .into_iter()
        .find(|family| id.starts_with(family))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Case {
        id: String,
        protocol: AiProtocol,
        model_type: AiModelType,
        context_window: Option<u32>,
        can_vision: bool,
        group: Option<String>,
    }

    #[test]
    fn matches_fixture() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../fixtures/ai-classify.json")).unwrap();
        assert!(cases.len() >= 25);
        for case in cases {
            let expected = AiModel {
                id: case.id.clone(),
                model_type: case.model_type,
                type_source: AiTypeSource::Inferred,
                context_window: case.context_window,
                can_vision: case.can_vision,
            };
            assert_eq!(infer(&case.id, case.protocol), expected, "{}", case.id);
            assert_eq!(group_of(&case.id), case.group, "{}", case.id);
        }
    }
}
