use std::sync::{Mutex, OnceLock};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};

const EVENT_NAME: &str = "lazyshell:menu";
const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Clone, Copy)]
struct WindowSnapshot {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

#[derive(Clone, Copy)]
enum WindowPlacement {
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Fill,
}

static PREVIOUS_WINDOW_FRAME: OnceLock<Mutex<Option<WindowSnapshot>>> = OnceLock::new();

fn previous_window_frame() -> &'static Mutex<Option<WindowSnapshot>> {
    PREVIOUS_WINDOW_FRAME.get_or_init(|| Mutex::new(None))
}

fn emit_to_main(app: &AppHandle, payload: &str) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.emit(EVENT_NAME, payload);
    }
}

fn active_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window(MAIN_WINDOW_LABEL))
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn bring_all_to_front(app: &AppHandle) {
    for window in app.webview_windows().into_values() {
        let _ = window.show();
        let _ = window.unminimize();
    }
    show_main_window(app);
}

fn remember_current_frame(window: &WebviewWindow) -> tauri::Result<()> {
    let mut previous = previous_window_frame().lock().unwrap();
    if previous.is_none() {
        *previous = Some(WindowSnapshot {
            position: window.outer_position()?,
            size: window.outer_size()?,
        });
    }
    Ok(())
}

fn restore_previous_frame(app: &AppHandle) {
    let Some(window) = active_window(app) else {
        return;
    };

    let snapshot = previous_window_frame().lock().unwrap().take();
    if let Some(snapshot) = snapshot {
        let _ = window.set_fullscreen(false);
        let _ = window.set_position(snapshot.position);
        let _ = window.set_size(snapshot.size);
        let _ = window.set_focus();
    }
}

fn place_window(app: &AppHandle, placement: WindowPlacement) {
    let Some(window) = active_window(app) else {
        return;
    };

    let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) else {
        return;
    };

    let _ = remember_current_frame(&window);
    let _ = window.set_fullscreen(false);

    let area = monitor.work_area();
    let x = area.position.x;
    let y = area.position.y;
    let width = area.size.width.max(1);
    let height = area.size.height.max(1);
    let half_width = (width / 2).max(1);
    let half_height = (height / 2).max(1);

    let (target_x, target_y, target_width, target_height) = match placement {
        WindowPlacement::Left => (x, y, half_width, height),
        WindowPlacement::Right => (x + half_width as i32, y, width - half_width, height),
        WindowPlacement::Top => (x, y, width, half_height),
        WindowPlacement::Bottom => (x, y + half_height as i32, width, height - half_height),
        WindowPlacement::TopLeft => (x, y, half_width, half_height),
        WindowPlacement::TopRight => (x + half_width as i32, y, width - half_width, half_height),
        WindowPlacement::BottomLeft => (x, y + half_height as i32, half_width, height - half_height),
        WindowPlacement::BottomRight => (
            x + half_width as i32,
            y + half_height as i32,
            width - half_width,
            height - half_height,
        ),
        WindowPlacement::Fill => (x, y, width, height),
    };

    let _ = window.set_position(PhysicalPosition::new(target_x, target_y));
    let _ = window.set_size(PhysicalSize::new(target_width, target_height));
    let _ = window.set_focus();
}

fn toggle_fullscreen_tile(app: &AppHandle) {
    if let Some(window) = active_window(app) {
        let _ = remember_current_frame(&window);
        let next_fullscreen = !window.is_fullscreen().unwrap_or(false);
        let _ = window.set_fullscreen(next_fullscreen);
        let _ = window.set_focus();
    }
}

fn handle_window_menu(app: &AppHandle, id: &str) -> bool {
    match id {
        "window:tile-fullscreen" => toggle_fullscreen_tile(app),
        "window:move:left" | "window:arrange:left-right" => place_window(app, WindowPlacement::Left),
        "window:move:right" | "window:arrange:right-left" => place_window(app, WindowPlacement::Right),
        "window:move:top" | "window:arrange:top-bottom" => place_window(app, WindowPlacement::Top),
        "window:move:bottom" | "window:arrange:bottom-top" => place_window(app, WindowPlacement::Bottom),
        "window:move:top-left" => place_window(app, WindowPlacement::TopLeft),
        "window:move:top-right" => place_window(app, WindowPlacement::TopRight),
        "window:move:bottom-left" => place_window(app, WindowPlacement::BottomLeft),
        "window:move:bottom-right" => place_window(app, WindowPlacement::BottomRight),
        "window:arrange:quarters" => place_window(app, WindowPlacement::Fill),
        "window:restore-previous-size" => restore_previous_frame(app),
        "window:show-main" => show_main_window(app),
        "window:bring-all-to-front" => bring_all_to_front(app),
        _ => return false,
    }
    true
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = Submenu::with_items(
        app,
        "LazyShell",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "view:layout:all", "Show All Panels", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "view:layout:sidebar-terminal",
                "Sidebar + Terminal",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "view:layout:terminal-ai",
                "Terminal + AI",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "view:layout:terminal-fullscreen",
                "Terminal Only",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view:toggle-sidebar", "Toggle Sidebar", true, Some("CmdOrCtrl+B"))?,
            &MenuItem::with_id(
                app,
                "view:toggle-ai",
                "Toggle AI Assistant",
                true,
                Some("CmdOrCtrl+Shift+I"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view:settings", "Settings...", true, Some("CmdOrCtrl+,"))?,
        ],
    )?;

    let move_resize_menu = Submenu::with_items(
        app,
        "移动与调整大小",
        true,
        &[
            &MenuItem::with_id(app, "window:tile-fullscreen", "全屏幕平铺", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "window:move:left", "左侧", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:move:right", "右侧", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:move:top", "顶部", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:move:bottom", "底部", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "window:move:top-left", "左上", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:move:top-right", "右上", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:move:bottom-left", "左下", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:move:bottom-right", "右下", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "window:arrange:left-right", "左侧与右侧", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:arrange:right-left", "右侧与左侧", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:arrange:top-bottom", "顶部与底部", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:arrange:bottom-top", "底部与顶部", true, None::<&str>)?,
            &MenuItem::with_id(app, "window:arrange:quarters", "四等分", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "window:restore-previous-size",
                "恢复上一个大小",
                true,
                None::<&str>,
            )?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &move_resize_menu,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &MenuItem::with_id(app, "window:remove-from-group", "从组中移除窗口", false, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "window:bring-all-to-front",
                "Bring All to Front",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "window:show-main", "LazyShell", true, true, None::<&str>)?,
        ],
    )?;

    let help_menu = Submenu::with_items(app, "Help", true, &[])?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if handle_window_menu(app, id) {
            return;
        }

        match id {
            "view:layout:all"
            | "view:layout:sidebar-terminal"
            | "view:layout:terminal-ai"
            | "view:layout:terminal-fullscreen"
            | "view:toggle-sidebar"
            | "view:toggle-ai"
            | "view:settings" => emit_to_main(app, id),
            _ => {}
        }
    });

    Ok(())
}
