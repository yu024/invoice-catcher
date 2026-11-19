// 逐帧渲染 stage.html 为 1080p MP4（或导出指定时间点的 PNG 截图）。
// 用法：swift render.swift <url> <out.mp4> [fps] [seconds]
//      swift render.swift <url> --stills <dir> 1.0,13.5,...
import AppKit
import AVFoundation
import WebKit

let W = 1920, H = 1080
let args = CommandLine.arguments
let url = URL(string: args[1])!
let stillsMode = args[2] == "--stills"

final class Renderer: NSObject, WKNavigationDelegate {
  let web: WKWebView
  let window: NSWindow
  var writer: AVAssetWriter?
  var input: AVAssetWriterInput?
  var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  var frames: [Double] = []
  var index = 0
  var fps = 30.0
  var outPath = ""
  var stillsDir = ""
  var skip = 0

  override init() {
    let cfg = WKWebViewConfiguration()
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: W, height: H), configuration: cfg)
    let env = ProcessInfo.processInfo.environment
    window = NSWindow(contentRect: NSRect(x: Double(env["WX"] ?? "-4000")!, y: 0, width: Double(W), height: Double(H)), styleMask: [.borderless], backing: .buffered, defer: false)
    super.init()
    window.contentView = web
    window.alphaValue = CGFloat(Double(env["WA"] ?? "1")!)
    window.level = .init(Int(env["WL"] ?? "0")!)
    window.orderFrontRegardless()
    web.navigationDelegate = self
  }

  func start() {
    if stillsMode {
      stillsDir = args[3]
      frames = args[4].split(separator: ",").map { Double($0)! * 1000 }
    } else {
      outPath = args[2]
      fps = args.count > 3 ? Double(args[3])! : 30
      let secs = args.count > 4 ? Double(args[4])! : 60
      let n = Int(secs * fps)
      frames = (0..<n).map { Double($0) * 1000 / fps }
      if args.count > 6 { skip = Int(args[5])!; frames = Array(frames[0..<min(n, Int(args[6])!)]) }
      try? FileManager.default.removeItem(atPath: outPath)
      let w = try! AVAssetWriter(outputURL: URL(fileURLWithPath: outPath), fileType: .mp4)
      let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: W, AVVideoHeightKey: H,
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 16_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
      ]
      let inp = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
      inp.expectsMediaDataInRealTime = false
      adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
      ])
      w.add(inp)
      w.startWriting()
      w.startSession(atSourceTime: .zero)
      writer = w
      input = inp
    }
    web.load(URLRequest(url: url))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { waitReady() }

  func waitReady() {
    web.evaluateJavaScript("window.__ready === true") { r, _ in
      if (r as? Bool) == true {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.next() }
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitReady() }
      }
    }
  }

  func next() {
    if index >= frames.count { finish(); return }
    let ms = frames[index]
    if index < skip {
      web.evaluateJavaScript("window.__frame(\(ms))") { _, _ in self.index += 1; self.next() }
      return
    }
    web.evaluateJavaScript("window.__frame(\(ms))") { _, err in
      if let err = err { print("JS error at \(ms): \(err)") }
      // 给合成器一个刷新周期
      DispatchQueue.main.async { self.capture(ms) }
    }
  }

  func capture(_ ms: Double) {
    let cfg = WKSnapshotConfiguration()
    cfg.afterScreenUpdates = ProcessInfo.processInfo.environment["AFTER"] != "0"
    cfg.snapshotWidth = NSNumber(value: W)
    web.takeSnapshot(with: cfg) { image, err in
      guard let image = image else { print("snapshot failed: \(String(describing: err))"); exit(1) }
      self.emit(image, ms)
      self.index += 1
      if self.index % 150 == 0 { print("frame \(self.index)/\(self.frames.count) \(Int(Date().timeIntervalSince(t0)))s"); fflush(stdout) }
      self.next()
    }
  }

  func draw(_ image: NSImage, into ctx: CGContext) {
    ctx.interpolationQuality = .high
    var rect = NSRect(x: 0, y: 0, width: W, height: H)
    if let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) {
      ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
    }
  }

  func emit(_ image: NSImage, _ ms: Double) {
    if stillsMode {
      let cs = CGColorSpace(name: CGColorSpace.sRGB)!
      let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)!
      draw(image, into: ctx)
      let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
      let data = rep.representation(using: .png, properties: [:])!
      try! data.write(to: URL(fileURLWithPath: "\(stillsDir)/t\(String(format: "%05.1f", ms / 1000)).png"))
      return
    }
    guard let pool = adaptor!.pixelBufferPool else { print("no pool"); exit(1) }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
    let buf = pb!
    CVPixelBufferLockBaseAddress(buf, [])
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: W, height: H, bitsPerComponent: 8,
                        bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    draw(image, into: ctx)
    CVPixelBufferUnlockBaseAddress(buf, [])
    while !input!.isReadyForMoreMediaData { RunLoop.current.run(until: Date().addingTimeInterval(0.005)) }
    adaptor!.append(buf, withPresentationTime: CMTime(value: CMTimeValue(index - skip), timescale: CMTimeScale(fps)))
  }

  func finish() {
    if stillsMode { print("stills done"); exit(0) }
    input!.markAsFinished()
    writer!.finishWriting {
      print("done: \(self.outPath) status=\(self.writer!.status.rawValue) \(String(describing: self.writer!.error))")
      exit(0)
    }
  }
}

let app = NSApplication.shared
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical, .idleDisplaySleepDisabled], reason: "render")
let t0 = Date()
app.setActivationPolicy(.accessory)
let r = Renderer()
r.start()
app.run()
