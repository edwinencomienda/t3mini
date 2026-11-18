import SwiftUI
import UIKit

/// A photo you can pinch, pan, and double-tap, like Photos and Messages: UIKit's zooming scroll
/// view moves the already-drawn picture on the GPU, so zooming stays smooth even for big images
/// (a SwiftUI scaleEffect driven by gestures redraws the view on every finger move).
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    /// Swipe down (not zoomed in): 0…1 as it's dragged, for fading the backdrop.
    var onDrag: (CGFloat) -> Void = { _ in }
    /// Swiped down far or fast enough: close.
    var onDismiss: () -> Void = {}

    func makeUIView(context: Context) -> ZoomingImageView { ZoomingImageView(image: image) }

    func updateUIView(_ view: ZoomingImageView, context: Context) {
        view.show(image)
        view.onDrag = onDrag
        view.onDismiss = onDismiss
    }
}

final class ZoomingImageView: UIScrollView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    private let imageView = UIImageView()
    private var fittedFor: CGSize = .zero
    var onDrag: (CGFloat) -> Void = { _ in }
    var onDismiss: () -> Void = {}
    private lazy var dismissPan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))

    init(image: UIImage) {
        super.init(frame: .zero)
        delegate = self
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        decelerationRate = .fast
        bouncesZoom = true
        imageView.image = image
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        addSubview(imageView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        dismissPan.delegate = self
        addGestureRecognizer(dismissPan)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// A sharper copy of the same picture (the full-size one, once loaded) keeps the zoom.
    func show(_ image: UIImage) {
        guard imageView.image !== image else { return }
        imageView.image = image
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != fittedFor { fit() }
        centerImage()
    }

    /// The whole picture on screen at 1×; zooms up to 6× (more for very large images).
    private func fit() {
        guard let size = imageView.image?.size, size.width > 0, size.height > 0,
              bounds.width > 0, bounds.height > 0 else { return }
        fittedFor = bounds.size
        zoomScale = 1
        let fitted = min(bounds.width / size.width, bounds.height / size.height)
        imageView.frame = CGRect(x: 0, y: 0, width: size.width * fitted, height: size.height * fitted)
        contentSize = imageView.frame.size
        minimumZoomScale = 1
        let pixels = size.width * (imageView.image?.scale ?? 1)
        maximumZoomScale = max(6, pixels / (imageView.frame.width * max(traitCollection.displayScale, 1)) * 2)
    }

    /// Smaller than the screen: centered, not stuck in the top-left corner.
    private func centerImage() {
        let x = max(0, (bounds.width - contentSize.width) / 2)
        let y = max(0, (bounds.height - contentSize.height) / 2)
        contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    // MARK: Swipe down to close, like Photos

    /// Only at the whole-picture size, and only a mostly downward drag (sideways goes to the next
    /// image, and zoomed in, dragging pans).
    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard gesture === dismissPan else { return super.gestureRecognizerShouldBegin(gesture) }
        guard zoomScale <= minimumZoomScale + 0.01 else { return false }
        let velocity = dismissPan.velocity(in: self)
        return velocity.y > 0 && velocity.y > abs(velocity.x) * 1.2
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        other === panGestureRecognizer
    }

    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        let move = gesture.translation(in: superview)
        let progress = min(1, max(0, move.y) / 300)
        switch gesture.state {
        case .changed:
            transform = CGAffineTransform(translationX: move.x, y: move.y)
                .scaledBy(x: 1 - progress * 0.25, y: 1 - progress * 0.25)
            onDrag(progress)
        case .ended, .cancelled:
            let velocity = gesture.velocity(in: superview).y
            if gesture.state == .ended && (move.y > 110 || velocity > 900) {
                onDismiss()
            } else {
                UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0) {
                    self.transform = .identity
                }
                onDrag(0)
            }
        default:
            break
        }
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }

    /// Zoomed in: back to the whole picture. Else in to 2.5× around where you tapped.
    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale + 0.01 {
            setZoomScale(minimumZoomScale, animated: true)
            return
        }
        let scale = min(2.5, maximumZoomScale)
        let point = gesture.location(in: imageView)
        let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
        zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                        width: size.width, height: size.height), animated: true)
    }
}
