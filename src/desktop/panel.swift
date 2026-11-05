import AppKit
import CoreImage

// oncall desktop panel.
//
// usage: oncall-panel [--passive | --qr <text>] <timeout-sec> <title> <where> <body> [option-label ...]
// stdout (one line): button:<index> | text:<answer> | timeout | dismiss
//
// A floating panel in the top-right corner of the screen under the mouse. It
// joins every Space so the user does not have to switch desktops.
//
// No panel takes the keyboard as it opens. Panels appear when an agent gets
// somewhere, not when the user is ready for them, mostly while they are typing
// in some other app, and a panel that took the caret as it appeared caught the
// rest of their sentence (an Enter in it even answered with option 1). So a
// panel opens on top and takes nothing until it is clicked. A button answers
// on the first click. A click anywhere else activates the panel and puts the
// caret in the field, and from then on Enter in the empty field picks the first
// option, Cmd+1..9 pick options by number, and Esc or the close button
// dismisses.
//
// With --passive it only reports, and never takes the keyboard even when
// clicked: no text field, an ordinary window level. It shows up over the window
// in front once, and the next click on that window covers it again. Since it
// is never key, Esc does not reach it; the close button does. The done panel
// uses it — a finished turn needs reading, not answering.
//
// With --qr the body and the text field give way to a QR code of <text>, with
// <body> as its caption: the pairing panel. Whoever spawned it closes it once
// the code has been scanned; Esc, once it is clicked, or the close button
// cancels. --qr is never passive; given both, --qr wins.

enum Focus { case click, never }

var argv = Array(CommandLine.arguments.dropFirst())
var focusFlag = Focus.click
if argv.first == "--passive" {
  focusFlag = .never
  argv.removeFirst()
} else if argv.first == "--click-to-focus" {
  // What every panel does now; accepted so a caller that still says so works.
  argv.removeFirst()
}
var qrText: String? = nil
if argv.first == "--qr", argv.count >= 2 {
  qrText = argv[1]
  argv.removeFirst(2)
}
let focus = qrText == nil ? focusFlag : .click
let passive = focus == .never
guard argv.count >= 4 else {
  FileHandle.standardError.write(
    "usage: oncall-panel [--passive | --qr <text>] <timeout> <title> <where> <body> [option ...]\n".data(using: .utf8)!)
  exit(2)
}
let timeout = max(1, Double(argv[0]) ?? 60)
let title = argv[1]
let location = argv[2]
let body = argv[3]
let options = Array(argv.dropFirst(4))

func finish(_ result: String) -> Never {
  print(result)
  fflush(stdout)
  exit(0)
}

// A panel that has not been clicked yet.
var awaitingClick = focus == .click
// Looks at a mouse-down before the window does; true means it was dealt with
// and must not reach the view. Every panel but a passive one sets one.
var interceptMouseDown: ((NSEvent) -> Bool)? = nil

final class PanelWindow: NSPanel {
  override func cancelOperation(_ sender: Any?) { finish("dismiss") }
  // A panel that may not take the keyboard yet must not be able to become key
  // at all. A `.nonactivatingPanel` that can become key is made key by AppKit
  // as soon as launching finishes, with no activate call anywhere, and from
  // then on it has the keystrokes and the input method while the user's app
  // still looks active (measured: key and `isActive` both true 0.04 s after
  // launch). A passive panel pays for it with Esc: the close button, the
  // timeout or the hook close it.
  override var canBecomeKey: Bool { !passive && !awaitingClick }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .leftMouseDown, let intercept = interceptMouseDown, intercept(event) {
      return
    }
    super.sendEvent(event)
  }

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
  debugLog("screen=\(NSStringFromRect(visible)) frame=\(NSStringFromRect(frame)) window=\(window.windowNumber)")
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
// Every panel starts as a background-only process (`.prohibited`), which
// macOS will not activate at all. Not calling `activate` is not enough as an
// `.accessory` app: when the frontmost app is the one this process descends
// from (the terminal Herdr runs in — where the user is most likely typing),
// launching hands activation over, and the user's app loses the keyboard 0.05 s
// after the panel appears (measured: `didBecomeActive`, `lsappinfo front`
// switched to the panel). A background-only process still shows its window and
// takes mouse clicks. A panel turns into an `.accessory` app when it is clicked.
app.setActivationPolicy(.prohibited)
let handler = Handler()

let screen = targetScreen()

let width: CGFloat = qrText == nil ? 540 : 320
let pad: CGFloat = 12
let rowH: CGFloat = 28
let rowGap: CGFloat = 4
let margin: CGFloat = 16
let labelWidth = width - 2 * pad
let optionsH = CGFloat(options.count) * (rowH + rowGap)
// A QR panel shows a code instead, and a passive one has nothing to answer.
let wantsField = qrText == nil && !passive
let fieldH: CGFloat = wantsField ? 4 + 26 : 0
let qrSide: CGFloat = 220
let qrBox: CGFloat = qrSide + 32
let captionFont = NSFont.systemFont(ofSize: 12)

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

// CoreImage draws the code one point per module. It is scaled by a whole
// number with nearest-neighbour sampling, at twice the size for a Retina
// backing, so every module stays a crisp square a phone camera can read.
func qrImage(_ text: String, side: CGFloat) -> NSImage? {
  guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
  filter.setValue(Data(text.utf8), forKey: "inputMessage")
  filter.setValue("M", forKey: "inputCorrectionLevel")
  guard let code = filter.outputImage, code.extent.width > 0 else { return nil }
  let scale = max(1, floor(side / code.extent.width))
  let pixels = code.samplingNearest().transformed(by: CGAffineTransform(scaleX: scale * 2, y: scale * 2))
  guard let image = CIContext().createCGImage(pixels, from: pixels.extent) else { return nil }
  return NSImage(cgImage: image, size: NSSize(width: code.extent.width * scale, height: code.extent.height * scale))
}

// Everything except the scrolling body.
let chromeH = pad + locationH + 2 + statusH + 8 + 8 + optionsH + fieldH + pad
// Size the body to what this screen can actually show — a taller panel would
// be clipped, and the body scrolls anyway. A QR panel's body is the code and
// its caption, which do not scroll.
let roomForBody = screen.visibleFrame.height - 2 * margin - 28 - chromeH
let wantedLines = min(22, max(3, body.split(separator: "\n", omittingEmptySubsequences: false).count))
let captionH = qrText == nil ? 0 : textHeight(body, font: captionFont, width: labelWidth, maxLines: 6)
let bodyH = qrText == nil ? max(48, min(CGFloat(wantedLines) * 15 + 8, roomForBody)) : qrBox + 8 + captionH
let height = chromeH + bodyH

// Every panel is a `.nonactivatingPanel`, so a click on it (to scroll, to
// close, on a button, or by accident) is handled without asking for
// activation; together with the background-only policy and a window that
// cannot become key, the user's app keeps the keyboard, the menu bar and the
// input method until the panel is deliberately clicked. A passive panel also
// sits at the ordinary window level, where the next click on the user's own
// window covers it; every other panel is something to answer and floats.
// `.utilityWindow` panels float by default (level 3, `isFloatingPanel` true),
// so both are set either way rather than left to that default.
let panelStyle: NSWindow.StyleMask = [.titled, .closable, .utilityWindow, .hudWindow, .nonactivatingPanel]
let panel = PanelWindow(
  contentRect: NSRect(x: 0, y: 0, width: width, height: height),
  styleMask: panelStyle,
  backing: .buffered,
  defer: false)
panel.title = "oncall"
panel.level = passive ? .normal : .floating
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
panel.isFloatingPanel = !passive
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
if let qrText {
  let box = NSView(frame: NSRect(x: (width - qrBox) / 2, y: y + bodyH - qrBox, width: qrBox, height: qrBox))
  box.wantsLayer = true
  box.layer?.backgroundColor = NSColor.white.cgColor
  box.layer?.cornerRadius = 6
  if let image = qrImage(qrText, side: qrSide) {
    let view = NSImageView(frame: NSRect(
      x: (qrBox - image.size.width) / 2, y: (qrBox - image.size.height) / 2,
      width: image.size.width, height: image.size.height))
    view.image = image
    view.imageScaling = .scaleNone
    box.addSubview(view)
  }
  content.addSubview(box)
  let caption = NSTextField(wrappingLabelWithString: body)
  caption.font = captionFont
  caption.textColor = .labelColor
  caption.alignment = .center
  caption.frame = NSRect(x: pad, y: y, width: labelWidth, height: captionH)
  content.addSubview(caption)
} else {
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
}

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

var field: NSTextField? = nil
let answerHint =
  options.isEmpty ? "type an instruction, Enter to send" : "Enter = option 1, Cmd+N = option N, or type an answer"
// Until the panel is clicked, typing goes elsewhere; the field says what gets
// it here instead of promising keys that do not reach it yet.
let clickHint = options.isEmpty ? "click here, then type an instruction" : "press a button, or click here to type"
if wantsField {
  y -= (4 + 26)
  let input = NSTextField(frame: NSRect(x: pad, y: y, width: width - 2 * pad, height: 26))
  input.placeholderString = awaitingClick ? clickHint : answerHint
  input.font = NSFont.systemFont(ofSize: 12)
  input.target = handler
  input.action = #selector(Handler.submitted(_:))
  content.addSubview(input)
  field = input
}

// The panel's focus state as one debug line, for checking any of this by hand.
func debugState(_ tag: String) {
  var responder = panel.firstResponder.map { String(describing: type(of: $0)) } ?? "none"
  if let field, let editor = field.currentEditor(), panel.firstResponder === editor {
    responder = "field"
  }
  debugLog(
    "\(tag): focus=\(focus) level=\(panel.level.rawValue) floating=\(panel.isFloatingPanel) "
      + "key=\(panel.isKeyWindow) active=\(NSApp.isActive) field=\(field != nil) responder=\(responder)")
}

// An input method follows the *active application*, not whichever window holds
// the caret. As a `.nonactivatingPanel` that never activated, this field took
// raw keystrokes — fine for `y` or `1` — while the IME session stayed with the
// terminal, so there was no way to type Chinese, Japanese or Korean into it.
// So taking the keyboard always means activating, not only becoming key. It
// happens only on a click on the panel (interceptMouseDown below).
func takeKeyboard() {
  app.activate(ignoringOtherApps: true)
  panel.makeKeyAndOrderFront(nil)
  if let field {
    panel.makeFirstResponder(field)
  }
}

// Nothing here asks for focus, and nothing can hand it over (background-only
// above, not key-capable in PanelWindow): the panel is ordered in front once
// and the keyboard stays where it was.
panel.orderFrontRegardless()
placeTopRight(panel, on: screen, margin: margin)

if focus == .click {
  interceptMouseDown = { event in
    guard let content = panel.contentView else { return false }
    // The title bar (close button, dragging) works as it is.
    guard content.frame.contains(event.locationInWindow) else { return false }
    // A button answers on the first click, focused or not: there is nothing to
    // type, and the user's app need not give up the keyboard for it.
    var view = content.hitTest(event.locationInWindow)
    while let current = view {
      if current is NSButton {
        return false
      }
      view = current.superview
    }
    if awaitingClick {
      // The first click anywhere else is for the keyboard: the panel becomes an
      // app that can be active, takes the caret into the field (a QR panel has
      // none, but Esc reaches it now), and the click itself is spent on that
      // (on the body it would hand the caret to the read-only text instead).
      awaitingClick = false
      let switched = app.setActivationPolicy(.accessory)
      field?.placeholderString = answerHint
      takeKeyboard()
      debugLog("clicked: policy switched=\(switched)")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { debugState("focused") }
      return true
    }
    // Back on the panel after clicking elsewhere: it lost its activation with
    // that click, and without it the input method stays behind.
    if !NSApp.isActive {
      app.activate(ignoringOtherApps: true)
    }
    return false
  }
}

// What the window really ended up as, read once the run loop is going: the
// activation and key status that launching hands out arrive only then, so a
// reading taken here, before `app.run()`, says nothing.
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { debugState("opened") }
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish("timeout") }
app.run()
