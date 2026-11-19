// 把分段配音按时间点合成：输出 带配音参考版.mp4 与 配音_参考.m4a
import AVFoundation
let a = CommandLine.arguments
let video = URL(fileURLWithPath: a[1]), outDir = a[2], voDir = a[3]
let plan = try! String(contentsOfFile: voDir + "/plan.txt", encoding: .utf8).split(separator: "\n").map { $0.split(separator: " ") }
func build(withVideo: Bool) -> AVMutableComposition {
  let comp = AVMutableComposition()
  let at = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
  if withVideo {
    let v = AVURLAsset(url: video)
    let vt = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
    try! vt.insertTimeRange(CMTimeRange(start: .zero, duration: v.duration), of: v.tracks(withMediaType: .video)[0], at: .zero)
  }
  for p in plan {
    let asset = AVURLAsset(url: URL(fileURLWithPath: "\(voDir)/\(p[0]).aiff"))
    let start = CMTime(seconds: Double(p[1])!, preferredTimescale: 600)
    try! at.insertTimeRange(CMTimeRange(start: .zero, duration: asset.duration), of: asset.tracks(withMediaType: .audio)[0], at: start)
  }
  return comp
}
func export(_ comp: AVMutableComposition, _ preset: String, _ path: String, _ type: AVFileType) {
  try? FileManager.default.removeItem(atPath: path)
  let s = AVAssetExportSession(asset: comp, presetName: preset)!
  s.outputURL = URL(fileURLWithPath: path); s.outputFileType = type
  let sem = DispatchSemaphore(value: 0)
  s.exportAsynchronously { sem.signal() }
  sem.wait()
  print(path, s.status.rawValue, s.error as Any)
}
export(build(withVideo: false), AVAssetExportPresetAppleM4A, outDir + "/配音_参考.m4a", .m4a)
if FileManager.default.fileExists(atPath: video.path) {
  export(build(withVideo: true), AVAssetExportPresetHighestQuality, outDir + "/发票捕手_演示_带配音.mp4", .mp4)
}
