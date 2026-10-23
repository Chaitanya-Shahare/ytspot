// Hand-drawn 16px icons in the style of Spotify's Encore set (not copied from the app).
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

const svg = (children: React.ReactNode, stroke = false) =>
  function Icon({ size = 16, ...rest }: P) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill={stroke ? 'none' : 'currentColor'}
        stroke={stroke ? 'currentColor' : 'none'}
        strokeWidth={stroke ? 1.5 : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
      >
        {children}
      </svg>
    )
  }

export const Play = svg(<path d="M4 2.3a.6.6 0 0 1 .9-.52l9.6 5.7a.6.6 0 0 1 0 1.04l-9.6 5.7A.6.6 0 0 1 4 13.7z" />)
export const Pause = svg(
  <>
    <rect x="3" y="2" width="3.4" height="12" rx=".7" />
    <rect x="9.6" y="2" width="3.4" height="12" rx=".7" />
  </>
)
export const Next = svg(
  <>
    <path d="M2.5 2.6a.6.6 0 0 1 .9-.5l8.1 5.4a.6.6 0 0 1 0 1L3.4 13.9a.6.6 0 0 1-.9-.5z" />
    <rect x="12" y="2" width="1.6" height="12" rx=".6" />
  </>
)
export const Prev = svg(
  <>
    <path d="M13.5 2.6a.6.6 0 0 0-.9-.5L4.5 7.5a.6.6 0 0 0 0 1l8.1 5.4a.6.6 0 0 0 .9-.5z" />
    <rect x="2.4" y="2" width="1.6" height="12" rx=".6" />
  </>
)
export const Shuffle = svg(
  <>
    <path d="M1.5 4h2.2c1.1 0 2 .5 2.6 1.4l3.4 5.2c.6.9 1.5 1.4 2.6 1.4h2" />
    <path d="M1.5 12h2.2c1.1 0 2-.5 2.6-1.4l.5-.8M9.2 6.2l.5-.8C10.3 4.5 11.2 4 12.3 4h2" />
    <path d="M12.7 2.3 14.4 4l-1.7 1.7M12.7 10.3l1.7 1.7-1.7 1.7" />
  </>,
  true
)
export const Repeat = svg(
  <>
    <path d="M4.5 3.5h7a3 3 0 0 1 3 3v1.5M11.5 12.5h-7a3 3 0 0 1-3-3V8" />
    <path d="M6.2 1.8 4.5 3.5l1.7 1.7M9.8 14.2l1.7-1.7-1.7-1.7" />
  </>,
  true
)
export const Heart = svg(
  <path d="M8 13.8S1.5 10 1.5 5.7A3.3 3.3 0 0 1 8 4.4a3.3 3.3 0 0 1 6.5 1.3C14.5 10 8 13.8 8 13.8z" />,
  true
)
export const HeartFill = svg(
  <path d="M8 14.3s-7-4-7-8.6A3.8 3.8 0 0 1 8 3.9a3.8 3.8 0 0 1 7 1.8c0 4.6-7 8.6-7 8.6z" />
)
export const PlusCircle = svg(
  <>
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 5v6M5 8h6" />
  </>,
  true
)
export const CheckCircle = svg(
  <path
    fillRule="evenodd"
    d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm3.3-9.4a.75.75 0 0 0-1.1-1L7 8.4 5.8 7.1a.75.75 0 1 0-1.1 1l1.8 1.9a.75.75 0 0 0 1.1 0z"
  />
)
export const Home = svg(<path d="M8 1.2 1 6.6V15h4.5v-4.5h5V15H15V6.6z" />)
export const HomeOutline = svg(<path d="M8 1.9 1.75 6.9v7.35h3.75V9.75h5v4.5h3.75V6.9z" />, true)
export const Search = svg(
  <>
    <circle cx="7" cy="7" r="5.25" />
    <path d="m11 11 3.5 3.5" />
  </>,
  true
)
export const Library = svg(
  <>
    <path d="M2 1.5v13M5.5 1.5v13" />
    <path d="m9 2 4.7 12.3" />
  </>,
  true
)
export const Plus = svg(<path d="M8 2.5v11M2.5 8h11" />, true)
export const ChevronLeft = svg(<path d="M10.5 2.5 5 8l5.5 5.5" />, true)
export const ChevronRight = svg(<path d="M5.5 2.5 11 8l-5.5 5.5" />, true)
export const Queue = svg(
  <>
    <path d="M1.5 2.5h13M1.5 6.5h13M1.5 10.5h6" />
    <path d="M11 9.5v5l3.5-2.5z" fill="currentColor" />
  </>,
  true
)
export const NowPlaying = svg(
  <>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
    <path d="M10 1.5v13" />
    <path d="M4.5 6.5 6.8 8 4.5 9.5z" fill="currentColor" />
  </>,
  true
)
export const Volume = svg(
  <>
    <path d="M1.5 5.5h2.5L8 2v12l-4-3.5H1.5z" fill="currentColor" />
    <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.2a6.5 6.5 0 0 1 0 9.6" />
  </>,
  true
)
export const VolumeMute = svg(
  <>
    <path d="M1.5 5.5h2.5L8 2v12l-4-3.5H1.5z" fill="currentColor" />
    <path d="m10.5 6 4 4m0-4-4 4" />
  </>,
  true
)
export const Clock = svg(
  <>
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 4v4l2.5 1.5" />
  </>,
  true
)
export const More = svg(
  <>
    <circle cx="3" cy="8" r="1.5" />
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="13" cy="8" r="1.5" />
  </>
)
export const Close = svg(<path d="m3 3 10 10M13 3 3 13" />, true)
