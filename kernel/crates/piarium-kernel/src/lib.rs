//! Piarium's private system kernel library. The binary target only starts this runtime.
mod authority;
mod error;
mod model;
mod protocol;
mod protocol_generated;
mod runtime;
mod storage;
mod storage_schema;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    runtime::run()
}
