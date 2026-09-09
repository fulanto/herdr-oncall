import AppKit

// oncall desktop panel.
//
// usage: oncall-panel <timeout-sec> <title> <where> <body> [option-label ...]
// stdout (one line): button:<index> | text:<answer> | timeout | dismiss
//
// A floating, non-activating panel in the top-right corner of the screen
// under the mouse. It joins every Space so the user does not have to switch
// desktops. Enter in the empty field picks the first option; Cmd+1..9 pick
// options by number; Esc or the close button dismisses.

let args = CommandLine.arguments
guard args.count >= 5 else {
  FileHandle.standardError.write("usage: oncall-panel <timeout> <title> <where> <body> [option ...]\n".data(using: .utf8)!)
  exit(2)
}
let timeout = max(1, Double(args[1]) ?? 60)
let title = args[2]
let location = args[3]
let body = args[4]
let options = Array(args.dropFirst(5))

func finish(_ result: String) -> Never {
  print(result)
  fflush(stdout)
  exit(0)
}

final class PanelWindow: NSPanel {
  override func cancelOperation(_ sender: Any?) { finish("dismiss") }
  override var canBecomeKey: Bool { true }

  // AppKit otherwise pulls the window onto whichever screen it thinks it
  // belongs to and clamps the frame there. With a display arranged left of the
  // primary the target x is negative, gets clamped to the primary's minX, and
  // the panel lands in the top-left corner. We place it ourselves.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
    frameRect
  }
}

func debugLog(_ text: String) {
  guard ProcessInfo.processInfo.environment["DESKTOP_PANEL_DEBUG"] == "1" else { return }
  FileHandle.standardError.write("panel: \(text)\n".data(using: .utf8)!)
}

// The screen under the pointer, so the panel shows up where the user is
// looking. Falls back to the active screen, then the primary one.
func targetScreen() -> NSScreen {
  let mouse = NSEvent.mouseLocation
  if let hit = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) {
    return hit
  }
  return NSScreen.main ?? NSScreen.screens[0]
}

// Top-right of that screen's usable area, measured on the real window frame so
// the title bar is accounted for, and clamped so it can never leave the screen.
func placeTopRight(_ window: NSWindow, on screen: NSScreen, margin: CGFloat = 16) {
  let visible = screen.visibleFrame
  var frame = window.frame
  frame.size.width = min(frame.width, visible.width - 2 * margin)
  frame.size.height = min(frame.height, visible.height - 2 * margin)
  frame.origin.x = min(max(visible.maxX - frame.width - margin, visible.minX), visible.maxX - frame.width)
  frame.origin.y = min(max(visible.maxY - frame.height - margin, visible.minY), visible.maxY - frame.height)
  window.setFrame(frame, display: false)
  debugLog("screen=\(NSStringFromRect(visible)) frame=\(NSStringFromRect(frame))")
}

final class Handler: NSObject, NSWindowDelegate {
  @objc func clicked(_ sender: NSButton) { finish("button:\(sender.tag)") }
  @objc func submitted(_ sender: NSTextField) {
    let value = sender.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if !value.isEmpty {
      finish("text:\(value)")
    }
    if !options.isEmpty {
      finish("button:0")
    }
  }
  func windowWillClose(_ notification: Notification) { finish("dismiss") }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let handler = Handler()

let screen = targetScreen()

let width: CGFloat = 540
let pad: CGFloat = 12
let rowH: CGFloat = 28
let rowGap: CGFloat = 4
let margin: CGFloat = 16
let labelWidth = width - 2 * pad
let optionsH = CGFloat(options.count) * (rowH + rowGap)

// The location leads: with several panes in flight, which task this is matters
// more than what state it is in. It can be long ("repo · worktree name
// (branch) · pane 2"), so let it wrap to a second line rather than truncate
// the middle and hide the worktree.
let locationFont = NSFont.boldSystemFont(ofSize: 15)
let statusFont = NSFont.systemFont(ofSize: 11)

func lineHeight(_ font: NSFont) -> CGFloat {
  ceil(font.ascender - font.descender + font.leading)
}

func textHeight(_ text: String, font: NSFont, width: CGFloat, maxLines: Int) -> CGFloat {
  let measured = (text as NSString).boundingRect(
    with: NSSize(width: width, height: .greatestFiniteMagnitude),
    options: [.usesLineFragmentOrigin, .usesFontLeading],
    attributes: [.font: font])
  let line = lineHeight(font)
  return min(max(ceil(measured.height), line), line * CGFloat(maxLines))
}

let locationH = textHeight(location, font: locationFont, width: labelWidth, maxLines: 2)
let statusH = lineHeight(statusFont)

// Everything except the scrolling body.
let chromeH = pad + locationH + 2 + statusH + 8 + 8 + optionsH + 4 + 26 + pad
// Size the body to what this screen can actually show — a taller panel would
// be clipped, and the body scrolls anyway.
let roomForBody = screen.visibleFrame.height - 2 * margin - 28 - chromeH
let wantedLines = min(22, max(3, body.split(separator: "\n", omittingEmptySubsequences: false).count))
let bodyH = max(48, min(CGFloat(wantedLines) * 15 + 8, roomForBody))
let height = chromeH + bodyH

let panel = PanelWindow(
  contentRect: NSRect(x: 0, y: 0, width: width, height: height),
  styleMask: [.titled, .closable, .nonactivatingPanel, .utilityWindow, .hudWindow],
  backing: .buffered,
  defer: false)
panel.title = "oncall"
panel.level = .floating
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
panel.isFloatingPanel = true
panel.hidesOnDeactivate = false
panel.isReleasedWhenClosed = false
panel.delegate = handler
placeTopRight(panel, on: screen)

let content = panel.contentView!
var y = height - pad

y -= locationH
let locationLabel = NSTextField(labelWithString: location)
locationLabel.font = locationFont
locationLabel.textColor = .labelColor
locationLabel.maximumNumberOfLines = 2
locationLabel.lineBreakMode = .byTruncatingTail
locationLabel.preferredMaxLayoutWidth = labelWidth
locationLabel.frame = NSRect(x: pad, y: y, width: labelWidth, height: locationH)
content.addSubview(locationLabel)

y -= (2 + statusH)
let statusLabel = NSTextField(labelWithString: title)
statusLabel.font = statusFont
statusLabel.textColor = .secondaryLabelColor
statusLabel.lineBreakMode = .byTruncatingTail
statusLabel.frame = NSRect(x: pad, y: y, width: labelWidth, height: statusH)
content.addSubview(statusLabel)

y -= (8 + bodyH)
let scroll = NSScrollView(frame: NSRect(x: pad, y: y, width: width - 2 * pad, height: bodyH))
let text = NSTextView(frame: NSRect(origin: .zero, size: scroll.contentSize))
text.isEditable = false
text.isSelectable = true
text.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
text.textColor = .labelColor
text.backgroundColor = .clear
text.textContainerInset = NSSize(width: 4, height: 4)
text.string = body
text.autoresizingMask = [.width]
scroll.documentView = text
scroll.hasVerticalScroller = true
scroll.drawsBackground = false
scroll.borderType = .bezelBorder
content.addSubview(scroll)
// Stay at the top: the content that needs approving comes first, the options
// are repeated as buttons below.

y -= 8
for (index, label) in options.enumerated() {
  y -= rowH
  let button = NSButton(title: label, target: handler, action: #selector(Handler.clicked(_:)))
  button.frame = NSRect(x: pad, y: y, width: width - 2 * pad, height: rowH)
  button.bezelStyle = .rounded
  button.alignment = .left
  button.tag = index
  if index < 9 {
    button.keyEquivalent = String(index + 1)
    button.keyEquivalentModifierMask = [.command]
  }
  content.addSubview(button)
  y -= rowGap
}

y -= (4 + 26)
let field = NSTextField(frame: NSRect(x: pad, y: y, width: width - 2 * pad, height: 26))
field.placeholderString =
  options.isEmpty ? "type an instruction, Enter to send" : "Enter = option 1, Cmd+N = option N, or type an answer"
field.font = NSFont.systemFont(ofSize: 12)
field.target = handler
field.action = #selector(Handler.submitted(_:))
content.addSubview(field)

panel.makeKeyAndOrderFront(nil)
// Ordering front can still move a window on some macOS versions; re-assert.
placeTopRight(panel, on: screen, margin: margin)
panel.makeFirstResponder(field)
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish("timeout") }
app.run()
