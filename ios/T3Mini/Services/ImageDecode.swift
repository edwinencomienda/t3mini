import ImageIO
import UIKit

/// Turning image bytes into something ready to draw, off the main thread.
enum ImageDecode {
    /// In the conversation: the picture shrunk straight from the file to at most `maxPixel` on its
    /// long side (ImageIO never decodes the full size), so a 2048 px image costs a fraction of the
    /// memory and scrolls smoothly. Nil `maxPixel`: the full image, for the zoomable viewer.
    nonisolated static func decode(_ data: Data, maxPixel: Int?) -> UIImage? {
        guard let maxPixel else { return UIImage(data: data)?.preparingForDisplay() }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    /// Roughly what a decoded image takes in memory (for the cache's limit).
    nonisolated static func cost(_ image: UIImage) -> Int {
        Int(image.size.width * image.scale * image.size.height * image.scale * 4)
    }
}
