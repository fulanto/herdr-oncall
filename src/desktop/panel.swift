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

let width: CGFloat = 440
let pad: CGFloat = 12
let rowH: CGFloat = 28
let rowGap: CGFloat = 4
let bodyLines = max(3, min(14, body.split(separator: "\n", omittingEmptySubsequences: false).count))
let bodyH = CGFloat(bodyLines) * 15 + 8
let optionsH = CGFloat(options.count) * (rowH + rowGap)
let height = pad + 20 + 2 + 16 + 8 + bodyH + 8 + optionsH + 4 + 26 + pad

let mouse = NSEvent.mouseLocation
let screen =
  NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main ?? NSScreen.screens[0]
let visible = screen.visibleFrame
let origin = NSPoint(x: visible.maxX - width - 16, y: visible.maxY - height - 16)

let panel = PanelWindow(
  contentRect: NSRect(origin: origin, size: NSSize(width: width, height: height)),
  styleMask: [.titled, .closable, .nonactivatingPanel, .utilityWindow, .hudWindow],
  backing: .buffered,
  defer: false)
panel.title = "oncall"
panel.level = .floating
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
panel.isFloatingPanel = true
panel.hidesOnDeactivate = false
panel.isReleasedWhenClosed = false
panel.delegate = handler

let content = panel.contentView!
var y = height - pad

y -= 20
let titleLabel = NSTextField(labelWithString: title)
titleLabel.font = NSFont.boldSystemFont(ofSize: 14)
titleLabel.textColor = .labelColor
titleLabel.frame = NSRect(x: pad, y: y, width: width - 2 * pad, height: 20)
content.addSubview(titleLabel)

y -= (2 + 16)
let whereLabel = NSTextField(labelWithString: location)
whereLabel.font = NSFont.systemFont(ofSize: 11)
whereLabel.textColor = .secondaryLabelColor
whereLabel.lineBreakMode = .byTruncatingMiddle
whereLabel.frame = NSRect(x: pad, y: y, width: width - 2 * pad, height: 16)
content.addSubview(whereLabel)

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
text.scrollToEndOfDocument(nil)

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
panel.makeFirstResponder(field)
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish("timeout") }
app.run()
