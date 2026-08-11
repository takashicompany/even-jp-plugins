import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

import { onEvenHubEvent, setEventHandlers } from './events'
import { initRenderer, resetPageState, showScreen, updateContent } from './renderer'

const BRIDGE_TIMEOUT_MS = 4000

const GLASSES_HEADER = 'Hello Even'
const GLASSES_FOOTER = 'タップ:カウント / ダブルタップ:終了'

const bridgeStatusEl = document.getElementById('bridgeStatus') as HTMLSpanElement
const pageOriginEl = document.getElementById('pageOrigin') as HTMLSpanElement
const counterValueEl = document.getElementById('counterValue') as HTMLDivElement
const incrementBtn = document.getElementById('incrementBtn') as HTMLButtonElement
const logEl = document.getElementById('log') as HTMLPreElement

let bridge: EvenAppBridge | null = null
let counter = 0

const LOG_MAX_LINES = 100
function log(msg: string): void {
  const time = new Date().toLocaleTimeString()
  const lines = (`[${time}] ${msg}\n` + (logEl.textContent ?? '')).split('\n')
  logEl.textContent = lines.slice(0, LOG_MAX_LINES).join('\n')
  console.log(`[hello-even] ${msg}`)
}

function buildGlassesContent(): string {
  return ['even-jp-plugins のテスト用サンプルです', '', `count: ${counter}`].join('\n')
}

async function renderGlassesFull(): Promise<void> {
  if (!bridge) return
  try {
    await showScreen(GLASSES_HEADER, buildGlassesContent(), GLASSES_FOOTER)
  } catch (err) {
    log(`レンズ描画エラー: ${err}`)
  }
}

function increment(): void {
  counter++
  counterValueEl.textContent = String(counter)
  log(`カウント: ${counter}`)
  if (bridge) {
    void updateContent(buildGlassesContent()).catch((err) => log(`カウント表示エラー: ${err}`))
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    promise.then(
      (v) => { window.clearTimeout(timer); resolve(v) },
      (e) => { window.clearTimeout(timer); reject(e) },
    )
  })
}

async function boot(): Promise<void> {
  pageOriginEl.textContent = location.origin
  log(`起動: origin=${location.origin}`)

  incrementBtn.addEventListener('click', () => increment())

  try {
    bridge = await withTimeout(waitForEvenAppBridge(), BRIDGE_TIMEOUT_MS)
    bridgeStatusEl.textContent = '接続済み'
    bridgeStatusEl.className = 'status-value ok'
    log('bridge waitForEvenAppBridge: OK')
  } catch (err) {
    bridgeStatusEl.textContent = '未接続 (ブラウザ単体モード)'
    bridgeStatusEl.className = 'status-value err'
    log(`bridge waitForEvenAppBridge: ERROR ${err}`)
    return
  }

  initRenderer(bridge, log)
  setEventHandlers({
    onClick: () => increment(),
    onDoubleClick: () => {
      log('DOUBLE_CLICK → shutDownPageContainer(1)')
      void bridge?.shutDownPageContainer(1)
    },
    onForegroundEnter: () => {
      resetPageState()
      void renderGlassesFull()
    },
    onForegroundExit: () => resetPageState(),
    onLog: (msg) => log(msg),
  })

  await renderGlassesFull()
  bridge.onEvenHubEvent(onEvenHubEvent)
  log('レンズ初期描画 完了')
}

boot().catch((err) => log(`Fatal: ${err}`))
