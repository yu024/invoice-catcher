import AVFoundation; import AppKit
let a=AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1])); let g=AVAssetImageGenerator(asset:a)
g.requestedTimeToleranceBefore = .zero; g.requestedTimeToleranceAfter = .zero
for s in CommandLine.arguments[2].split(separator: ",") { let t = Double(s)!
  let im = try! g.copyCGImage(at: CMTime(seconds:t, preferredTimescale:600), actualTime:nil)
  let d = NSBitmapImageRep(cgImage: im).representation(using:.jpeg, properties:[.compressionFactor:0.7])!
  try! d.write(to: URL(fileURLWithPath:"check/\(s).jpg")) }
