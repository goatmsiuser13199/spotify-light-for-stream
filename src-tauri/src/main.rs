// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Avant la création du WebView2 : auto-accepte getUserMedia
  // pour lister casque / enceintes / HDMI avec leurs vrais noms.
  // SAFETY: appelé une seule fois au démarrage, avant tout autre thread.
  unsafe {
    std::env::set_var(
      "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
      // media permissions + moins d’overhead UI WebView2
      "--use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI,CalculateNativeWinOcclusion --disable-smooth-scrolling",
    );
  }
  app_lib::run();
}
