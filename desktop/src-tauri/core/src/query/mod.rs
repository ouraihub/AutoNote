//! Read-only library queries. All SQL stays inside note-core.
mod changes;
mod graph;
mod notes;
mod search;

pub use graph::{GraphEdge, GraphMeta, GraphNode, GraphQuery, GraphResponse, GraphTag};
pub use notes::{ListNotesQuery, NoteOrder, NoteSort, NoteView};
pub use search::{SearchHit, SearchMode, SearchQuery, SearchResponse, SearchTerms};

#[cfg(test)]
mod settings_tests;
#[cfg(test)]
mod tests;
