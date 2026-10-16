import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../attachments'

// A button that copies some text and shows a check for a moment (works on phones too: copyText
// falls back to a hidden textarea where the Clipboard API isn't allowed).
export function CopyButton({
  text,
  label,
  className,
}: {
  text: () => string
  label: string
  className: string
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : 'Copy'}
      onClick={() =>
        void copyText(text()).then(
          () => setCopied(true),
          () => {},
        )
      }
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}
