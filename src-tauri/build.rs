fn main() {
    link_clang_runtime();
    tauri_build::build()
}

/// whisper.cpp's Metal backend calls `___isPlatformVersionAtLeast`, which lives in Clang's
/// runtime library. Rust links with `-nodefaultlibs`, so on some toolchains (e.g. Homebrew
/// Rust with a new Xcode) the symbol is missing at link time unless we link it explicitly.
fn link_clang_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(out) = std::process::Command::new("clang")
        .arg("--print-resource-dir")
        .output()
    else {
        return;
    };
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let lib_dir = format!("{dir}/lib/darwin");
    if std::path::Path::new(&lib_dir).join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={lib_dir}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
