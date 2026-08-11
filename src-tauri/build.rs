use std::{env, fs, path::PathBuf};

fn stage_onnxruntime() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let library_dir = PathBuf::from(
        env::var("ORT_LIB_LOCATION").expect("ORT_LIB_LOCATION must point to ONNX Runtime"),
    );
    let source = library_dir.join("onnxruntime.dll");
    if !source.is_file() {
        panic!("onnxruntime.dll is missing; run `npm run prepare:runtime` before building Aevum");
    }
    println!("cargo:rerun-if-changed={}", source.display());

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let bundle_dir = manifest_dir.join("transcribe-libs");
    fs::create_dir_all(&bundle_dir).expect("create ONNX Runtime bundle directory");
    fs::copy(&source, bundle_dir.join("onnxruntime.dll"))
        .expect("stage onnxruntime.dll for the Windows installer");

    let output_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    if let Some(profile_dir) = output_dir.ancestors().nth(3) {
        fs::copy(&source, profile_dir.join("onnxruntime.dll"))
            .expect("stage onnxruntime.dll beside the development executable");
    }
}

fn main() {
    stage_onnxruntime();
    tauri_build::build()
}
