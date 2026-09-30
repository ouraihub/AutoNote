//! AutoNote desktop entrypoint.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    autonote_lib::run();
}
