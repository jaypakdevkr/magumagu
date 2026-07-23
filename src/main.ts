import './style.css'
import { BaseballGame } from './game'

const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas')
const statusText = document.querySelector<HTMLElement>('#statusText')
const controlHint = document.querySelector<HTMLElement>('#controlHint')
const muteButton = document.querySelector<HTMLButtonElement>('#muteButton')
const setupOverlay = document.querySelector<HTMLElement>('#setupOverlay')
const brandLink = document.querySelector<HTMLAnchorElement>('.brand')

if (!canvas || !statusText || !controlHint || !muteButton || !setupOverlay || !brandLink) {
  throw new Error('게임을 시작하는 데 필요한 화면 요소를 찾지 못했습니다.')
}

new BaseballGame(canvas, statusText, controlHint, muteButton, setupOverlay)

brandLink.addEventListener('click', (event) => {
  event.preventDefault()
  window.location.reload()
})
