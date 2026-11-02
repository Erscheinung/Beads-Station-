//! The native menu bar: the system defaults plus the app's own actions.
//!
//! Items carry no accelerators. Shortcuts stay in the rebindable frontend
//! registry, and a fixed native accelerator would override it. A click sends
//! the command id to the frontend, which runs it like the palette does.

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Wry};

/// `(command id, label)`; an empty id is a separator.
type Entries = &'static [(&'static str, &'static str)];
const SEPARATOR: (&str, &str) = ("", "");

const COMMAND_PREFIX: &str = "cmd:";
const LINK_PREFIX: &str = "link:";

const FILE: Entries = &[
    ("cmd:newTab", "New Terminal Tab"),
    ("cmd:splitH", "Split Right"),
    ("cmd:splitV", "Split Down"),
    SEPARATOR,
    ("cmd:newIssue", "New Issue…"),
    ("cmd:workspace", "Open Workspace…"),
    ("cmd:initializeBeads", "Initialize Beads in Workspace"),
    SEPARATOR,
    ("cmd:closePane", "Close Pane"),
    ("cmd:closeWorkspace", "Close Workspace"),
    SEPARATOR,
];
const VIEW: Entries = &[
    ("cmd:palette", "Command Palette"),
    ("cmd:terminal", "Terminal"),
    ("cmd:designer", "Designer"),
    ("cmd:showBoard", "Board"),
    ("cmd:themes", "Choose Theme…"),
    SEPARATOR,
    ("cmd:fullscreen", "Fullscreen Terminal"),
    ("cmd:zoomPane", "Zoom Pane"),
    ("cmd:terminalFontLarger", "Larger Text"),
    ("cmd:terminalFontSmaller", "Smaller Text"),
    ("cmd:terminalFontReset", "Default Text Size"),
    SEPARATOR,
];
const AGENTS: Entries = &[
    ("cmd:launchClaude", "Start Claude Code"),
    ("cmd:launchCodex", "Start Codex"),
    ("cmd:chatPanel", "Open Chat Panel"),
    SEPARATOR,
    ("cmd:notificationPanel", "Show Waiting Panes"),
    ("cmd:notificationJump", "Jump to Latest"),
];
const WINDOW: Entries = &[
    ("cmd:workspacePrevious", "Previous Workspace"),
    ("cmd:workspaceNext", "Next Workspace"),
    ("cmd:terminalPrevious", "Previous Terminal Tab"),
    ("cmd:terminalNext", "Next Terminal Tab"),
    SEPARATOR,
    ("cmd:unsplit", "Unsplit to Tabs"),
    ("cmd:joinTabs", "Join Tabs"),
    SEPARATOR,
];
const HELP: Entries = &[
    ("link:https://github.com/Erscheinung/Beads-Station/releases", "Release Notes"),
    ("link:https://github.com/Erscheinung/Beads-Station/issues/new", "Report a Bug or Request a Feature"),
    ("cmd:checkForUpdates", "Check for Updates…"),
];

fn prepend(app: &AppHandle, submenu: &Submenu<Wry>, entries: Entries) -> tauri::Result<()> {
    for (position, (id, label)) in entries.iter().enumerate() {
        if id.is_empty() {
            submenu.insert(&PredefinedMenuItem::separator(app)?, position)?;
        } else {
            submenu.insert(&MenuItem::with_id(app, *id, *label, true, None::<&str>)?, position)?;
        }
    }
    Ok(())
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    let mut window_position = None;
    for (position, item) in menu.items()?.iter().enumerate() {
        let MenuItemKind::Submenu(submenu) = item else { continue };
        match submenu.text()?.as_str() {
            "File" => prepend(app, submenu, FILE)?,
            "View" => prepend(app, submenu, VIEW)?,
            "Window" => {
                prepend(app, submenu, WINDOW)?;
                window_position = Some(position);
            }
            "Help" => prepend(app, submenu, HELP)?,
            _ => {}
        }
    }
    let agents = Submenu::new(app, "Agents", true)?;
    prepend(app, &agents, AGENTS)?;
    match window_position {
        Some(position) => menu.insert(&agents, position)?,
        None => menu.append(&agents)?,
    }
    // Shortcut dispatch stays in the frontend; see the module comment.
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        app_menu.insert(&MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?, 1)?;
    }
    Ok(menu)
}

pub fn on_event(app: &AppHandle, id: &str) {
    if id == "settings" {
        let _ = app.emit("settings:open", ());
    } else if let Some(command) = id.strip_prefix(COMMAND_PREFIX) {
        let _ = app.emit("menu:command", command);
    } else if let Some(url) = id.strip_prefix(LINK_PREFIX) {
        let _ = app.emit("menu:link", url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_menu_command_exists_in_the_frontend() {
        let commands = include_str!("../../src/state/commands.ts");
        for entries in [FILE, VIEW, AGENTS, WINDOW, HELP] {
            for (id, _) in entries {
                let Some(command) = id.strip_prefix(COMMAND_PREFIX) else { continue };
                assert!(commands.contains(&format!("id: '{command}'")), "{command}");
            }
        }
    }
}
