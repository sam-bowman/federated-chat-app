#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();
  // A link in a message opens in the person's own browser. It has to be registered HERE, not in `setup` with the plugins
  // below: it works by a script it adds to the window, and the main window already exists by the time `setup` runs, so
  // a plugin added there never gets its script (calling the plugin by hand worked; clicking a link did nothing).
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_opener::init());
  builder
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Updates (the Settings -> Updates section drives them) and the restart after one. Desktop only: there is
      // no updater on Android or iOS, and the crates are not built for them.
      #[cfg(desktop)]
      {
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;
        app.handle().plugin(tauri_plugin_notification::init())?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
