// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // --mcp:headless MCP Server(stdio JSON-RPC),
    // 不进 GUI / 托盘 / 单实例,由 MCP 客户端按需拉起
    if std::env::args().any(|a| a == "--mcp") {
        prompt_vault_lib::run_mcp();
        return;
    }
    prompt_vault_lib::run()
}
