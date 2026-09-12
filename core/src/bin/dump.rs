// Dump every face the plan built, and the outlines it was built from, so the
// compiled font can be held to its input from outside.
//
//   webpdf-core-dump <pdf> <out-dir>
use std::fmt::Write as _;
use std::fs;

use webpdf_core::font::build::Cmd;
use webpdf_core::Core;

fn cmds_json(cmds: &[Cmd]) -> String {
    let mut out = String::from("[");
    for (i, cmd) in cmds.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        match *cmd {
            Cmd::Move(x, y) => {
                let _ = write!(out, "[\"M\",{x},{y}]");
            }
            Cmd::Line(x, y) => {
                let _ = write!(out, "[\"L\",{x},{y}]");
            }
            Cmd::Curve(a, b, c, d, e, f) => {
                let _ = write!(out, "[\"C\",{a},{b},{c},{d},{e},{f}]");
            }
            Cmd::Close => out.push_str("[\"Z\"]"),
        }
    }
    out.push(']');
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = fs::read(&args[1]).expect("read pdf");
    let out_dir = &args[2];
    fs::create_dir_all(out_dir).expect("mkdir");

    let mut core = Core::open(&bytes, "application/pdf").expect("open");
    core.plan_fonts().expect("plan");

    let faces = core.plan_for_probe().compiled_faces();
    let mut manifest = String::from("[");
    for (i, face) in faces.iter().enumerate() {
        fs::write(format!("{out_dir}/face-{i}.otf"), &face.data).expect("write font");
        if i > 0 {
            manifest.push(',');
        }
        let _ = write!(
            manifest,
            "{{\"index\":{i},\"family\":\"{}\",\"file\":\"face-{i}.otf\",\"glyphs\":[",
            face.family
        );
        for (k, (gid, codes, cmds, advance)) in face.glyphs.iter().enumerate() {
            if k > 0 {
                manifest.push(',');
            }
            let codes: Vec<String> = codes.iter().map(|c| c.to_string()).collect();
            let _ = write!(
                manifest,
                "{{\"gid\":{gid},\"codes\":[{}],\"advance\":{},\"cmds\":{}}}",
                codes.join(","),
                advance.map(|a| a.to_string()).unwrap_or_else(|| "null".into()),
                cmds_json(cmds)
            );
        }
        manifest.push_str("]}");
    }
    manifest.push(']');
    fs::write(format!("{out_dir}/manifest.json"), manifest).expect("write manifest");
    println!("{} faces -> {out_dir}", faces.len());
}
