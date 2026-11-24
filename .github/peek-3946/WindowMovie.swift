import AVFoundation
import CoreGraphics
import Foundation
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
    static func main() async throws {
        guard CGDisplayIsActive(CGMainDisplayID()) != 0, CGPreflightScreenCaptureAccess() else {
            throw CaptureError.unavailable("No active Mac display with screen recording permission")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        if CommandLine.arguments.dropFirst().elementsEqual(["--preflight"]) {
            guard !content.displays.isEmpty else { throw CaptureError.unavailable("No capture display") }
            return
        }
        let args = CommandLine.arguments
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
