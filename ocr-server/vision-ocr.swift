// Vision OCR helper — compiled by server.js via swiftc to vision-bin
// Output (TSV, one line per observation, normalized coords, TOP-LEFT origin):
//   FILE\t<path>
//   TEXT\t<conf>\t<x0>\t<y0>\t<x1>\t<y1>\t<text>
//   BAR \t<symbology>\t<payload>\t<x0>\t<y0>\t<x1>\t<y1>
//   END
import Vision
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else { exit(0) }

func topLeftBox(_ bb: CGRect) -> (Double, Double, Double, Double) {
    // Vision coords are bottom-left origin; convert to top-left
    let x0 = Double(bb.minX), x1 = Double(bb.maxX)
    let y0 = 1.0 - Double(bb.maxY), y1 = 1.0 - Double(bb.minY)
    return (x0, y0, x1, y1)
}

for path in args.dropFirst() {
    print("FILE\t\(path)")
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("END")
        continue
    }

    let textReq = VNRecognizeTextRequest { req, _ in
        guard let obs = req.results as? [VNRecognizedTextObservation] else { return }
        for o in obs {
            guard let s = o.topCandidates(1).first else { continue }
            let (x0, y0, x1, y1) = topLeftBox(o.boundingBox)
            let text = s.string.replacingOccurrences(of: "\t", with: " ")
            print(String(format: "TEXT\t%.3f\t%.4f\t%.4f\t%.4f\t%.4f\t%@",
                         s.confidence, x0, y0, x1, y1, text))
        }
    }
    textReq.recognitionLanguages = ["en-US"]
    textReq.recognitionLevel = .accurate
    textReq.usesLanguageCorrection = false

    let barReq = VNDetectBarcodesRequest { req, _ in
        guard let obs = req.results as? [VNBarcodeObservation] else { return }
        for o in obs {
            let (x0, y0, x1, y1) = topLeftBox(o.boundingBox)
            let payload = (o.payloadStringValue ?? "?").replacingOccurrences(of: "\t", with: " ")
            print(String(format: "BAR\t%@\t%@\t%.4f\t%.4f\t%.4f\t%.4f",
                         o.symbology.rawValue, payload, x0, y0, x1, y1))
        }
    }

    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([textReq, barReq]) } catch { print("ERR\t\(error)") }
    print("END")
}
