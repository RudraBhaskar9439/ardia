import AVFoundation
import CoreText
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit

enum CaptureError: Error { case unavailable(String) }

final class Output: NSObject, SCRecordingOutputDelegate {
    let started: URL
    let finished: URL
    init(directory: URL) {
        started = directory.appendingPathComponent("started")
        finished = directory.appendingPathComponent("finished")
    }
    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        FileManager.default.createFile(atPath: started.path, contents: Data())
    }
    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        FileManager.default.createFile(atPath: finished.path, contents: Data())
    }
    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        FileHandle.standardError.write(Data("Recording failed: \(error)\n".utf8))
        exit(2)
    }
}

@main
struct WindowMovie {
    static func labels(_ path: String, width: Int, height: Int) throws {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw CaptureError.unavailable("Could not create the magnification title strip")
        }
        context.setFillColor(CGColor(red: 0.075, green: 0.102, blue: 0.125, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let font = CTFontCreateWithName("HelveticaNeue-Medium" as CFString, CGFloat(height) * 0.40, nil)
        for (index, title) in ["Left corner", "Right corner"].enumerated() {
            let attributes = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: CGColor(gray: 0.94, alpha: 1)] as CFDictionary
            let text = CFAttributedStringCreate(nil, title as CFString, attributes)!
            let line = CTLineCreateWithAttributedString(text)
            let lineWidth = CTLineGetTypographicBounds(line, nil, nil, nil)
            context.textPosition = CGPoint(x: CGFloat(width) * (CGFloat(index)/2 + 0.25) - lineWidth / 2, y: CGFloat(height) * 0.30)
            CTLineDraw(line, context)
        }
        guard let image = context.makeImage(), let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw CaptureError.unavailable("Could not write the magnification title strip")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw CaptureError.unavailable("Could not finish the magnification title strip") }
    }

    static func main() async throws {
        let args = CommandLine.arguments
        if args.count == 5, args[1] == "--labels", let width = Int(args[3]), let height = Int(args[4]), width > 0, height > 0 {
            try labels(args[2], width: width, height: height)
            return
        }
        guard CGDisplayIsActive(CGMainDisplayID()) != 0, CGPreflightScreenCaptureAccess() else {
            throw CaptureError.unavailable("No active Mac display with screen recording permission")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        if CommandLine.arguments.dropFirst().elementsEqual(["--preflight"]) {
            guard !content.displays.isEmpty else { throw CaptureError.unavailable("No capture display") }
            return
        }
        guard args.count == 5, let id = UInt32(args[1]), let pid = Int32(args[2]),
              let window = content.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == pid })
        else { throw CaptureError.unavailable("Ardia window and PID unavailable") }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        config.width = Int(filter.contentRect.width * scale) / 2 * 2
        config.height = Int(filter.contentRect.height * scale) / 2 * 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.ignoreShadowsSingleWindow = true
        config.showsCursor = false
        config.capturesAudio = false
        config.captureMicrophone = false
        if args[4] == "--still" {
            config.pixelFormat = kCVPixelFormatType_32BGRA
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let destination = URL(fileURLWithPath: args[3])
            guard let png = CGImageDestinationCreateWithURL(destination as CFURL, UTType.png.identifier as CFString, 1, nil) else {
                throw CaptureError.unavailable("Could not open the window PNG")
            }
            CGImageDestinationAddImage(png, image, nil)
            guard CGImageDestinationFinalize(png) else { throw CaptureError.unavailable("Could not write the window PNG") }
            return
        }
        let recording = SCRecordingOutputConfiguration()
        recording.outputURL = URL(fileURLWithPath: args[3])
        recording.outputFileType = .mp4
        recording.videoCodecType = .h264
        let dir = URL(fileURLWithPath: args[4])
        try JSONSerialization.data(withJSONObject: ["width": filter.contentRect.width, "height": filter.contentRect.height]).write(to: dir.appendingPathComponent("window.json"))
        let observer = Output(directory: dir)
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let output = SCRecordingOutput(configuration: recording, delegate: observer)
        try stream.addRecordingOutput(output)
        try await stream.startCapture()
        let deadline = Date().addingTimeInterval(40)
        let stop = dir.appendingPathComponent("stop")
        while !FileManager.default.fileExists(atPath: stop.path), Date() < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        try await stream.stopCapture()
        let finish = Date().addingTimeInterval(8)
        while !FileManager.default.fileExists(atPath: observer.finished.path), Date() < finish {
            try await Task.sleep(for: .milliseconds(100))
        }
        guard FileManager.default.fileExists(atPath: observer.finished.path),
              FileManager.default.fileExists(atPath: stop.path) else { throw CaptureError.unavailable("Window recording timed out") }
    }
}
