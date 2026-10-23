import type { Bridge } from '../../preload'

declare global {
  interface Window {
    ytm: Bridge
  }
}
