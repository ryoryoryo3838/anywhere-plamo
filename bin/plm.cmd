@echo off
rem plm for source checkouts on Windows: rebuilds the CLI when its sources changed, then runs it.
cargo run --quiet --manifest-path "%~dp0..\Cargo.toml" -p anyplm-cli -- %*
