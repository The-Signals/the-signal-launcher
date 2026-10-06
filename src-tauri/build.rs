fn main() {
    println!("cargo:rerun-if-changed=../distribution.json");
    tauri_build::build()
}
