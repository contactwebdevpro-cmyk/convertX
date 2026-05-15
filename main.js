const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

// ─── FFmpeg Path Resolution ───────────────────────────────────────────────────
function getFFmpegPath() {
  // In packaged app, ffmpeg is in resources
  if (app.isPackaged) {
    const platform = process.platform
    const arch = process.arch
    const ext = platform === 'win32' ? '.exe' : ''
    const resourcesPath = process.resourcesPath
    return path.join(resourcesPath, 'ffmpeg-bin', `${platform}-${arch}`, `ffmpeg${ext}`)
  }

  // In development, use @ffmpeg-installer/ffmpeg
  try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg')
    return ffmpegInstaller.path
  } catch {
    return 'ffmpeg' // fallback to system ffmpeg
  }
}

function getFFprobePath() {
  if (app.isPackaged) {
    const platform = process.platform
    const arch = process.arch
    const ext = platform === 'win32' ? '.exe' : ''
    const resourcesPath = process.resourcesPath
    return path.join(resourcesPath, 'ffmpeg-bin', `${platform}-${arch}`, `ffprobe${ext}`)
  }

  try {
    const ffprobeInstaller = require('@ffprobe-installer/ffprobe')
    return ffprobeInstaller.path
  } catch {
    return 'ffprobe'
  }
}

// ─── Window Creation ─────────────────────────────────────────────────────────
let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0f172a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    icon: path.join(__dirname, '../assets/icon.png'),
  })

  // Load URL
  const isDev = process.env.NODE_ENV === 'development'
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── Active Conversions Map ───────────────────────────────────────────────────
const activeConversions = new Map() // fileId -> ffmpegProcess

// ─── IPC Handlers ────────────────────────────────────────────────────────────

// Open file picker
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select video files',
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'm4v', 'wmv', 'mpeg', 'mpg'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  })
  return result.canceled ? [] : result.filePaths
})

// Select output directory
ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select output folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

// Get file metadata using ffprobe
ipcMain.handle('get-file-info', async (event, filePath) => {
  return new Promise((resolve) => {
    const ffprobePath = getFFprobePath()
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]

    const proc = spawn(ffprobePath, args)
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => { stdout += data.toString() })
    proc.stderr.on('data', (data) => { stderr += data.toString() })

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(stdout)
          const format = info.format || {}
          const videoStream = info.streams?.find(s => s.codec_type === 'video')
          const audioStream = info.streams?.find(s => s.codec_type === 'audio')

          resolve({
            success: true,
            duration: parseFloat(format.duration) || 0,
            size: parseInt(format.size) || 0,
            bitrate: parseInt(format.bit_rate) || 0,
            format: format.format_name || '',
            width: videoStream?.width || 0,
            height: videoStream?.height || 0,
            fps: videoStream ? eval(videoStream.r_frame_rate) : 0,
            videoCodec: videoStream?.codec_name || '',
            audioCodec: audioStream?.codec_name || '',
            channels: audioStream?.channels || 0,
            sampleRate: audioStream?.sample_rate || 0,
          })
        } catch (e) {
          resolve({ success: false, error: e.message })
        }
      } else {
        resolve({ success: false, error: stderr || 'ffprobe failed' })
      }
    })

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })
  })
})

// Start conversion
ipcMain.handle('start-conversion', async (event, job) => {
  const {
    fileId, inputPath, outputPath, format,
    quality, bitrate, audioBitrate,
    trimStart, trimEnd, preset,
    resolution, fps,
  } = job

  const ffmpegPath = getFFmpegPath()

  return new Promise((resolve) => {
    const args = ['-y'] // overwrite

    // Trim support
    if (trimStart && trimStart > 0) {
      args.push('-ss', String(trimStart))
    }

    args.push('-i', inputPath)

    if (trimEnd && trimEnd > 0) {
      args.push('-to', String(trimEnd - (trimStart || 0)))
    }

    // Format-specific encoding
    if (format === 'mp3') {
      args.push('-vn') // no video
      args.push('-acodec', 'libmp3lame')
      args.push('-ab', audioBitrate || getAudioBitrate(quality))
      args.push('-ar', '44100')
      args.push('-ac', '2')
    } else if (format === 'mp4') {
      args.push('-c:v', 'libx264')
      args.push('-preset', getX264Preset(quality))
      args.push('-crf', getCRF(quality))
      args.push('-c:a', 'aac')
      args.push('-ab', audioBitrate || '192k')
      args.push('-movflags', '+faststart')

      if (resolution && resolution !== 'original') {
        args.push('-vf', `scale=${resolution}:flags=lanczos`)
      }
      if (fps && fps !== 'original') {
        args.push('-r', String(fps))
      }
      if (bitrate && quality === 'custom') {
        args.push('-b:v', bitrate)
      }
    }

    args.push(outputPath)

    const proc = spawn(ffmpegPath, args)
    activeConversions.set(fileId, proc)

    let duration = 0
    let stderr = ''

    proc.stderr.on('data', (data) => {
      const chunk = data.toString()
      stderr += chunk

      // Parse duration from ffmpeg output
      const durMatch = chunk.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
      if (durMatch) {
        const h = parseInt(durMatch[1])
        const m = parseInt(durMatch[2])
        const s = parseFloat(durMatch[3])
        duration = h * 3600 + m * 60 + s
      }

      // Parse current time for progress
      const timeMatch = chunk.match(/time=(\d+):(\d+):(\d+\.?\d*)/)
      if (timeMatch && duration > 0) {
        const h = parseInt(timeMatch[1])
        const m = parseInt(timeMatch[2])
        const s = parseFloat(timeMatch[3])
        const currentTime = h * 3600 + m * 60 + s
        const progress = Math.min(Math.round((currentTime / duration) * 100), 99)

        // Parse speed/bitrate info
        const speedMatch = chunk.match(/speed=\s*(\S+)/)
        const bitrateMatch = chunk.match(/bitrate=\s*(\S+)/)

        mainWindow?.webContents.send('conversion-progress', {
          fileId,
          progress,
          currentTime,
          duration,
          speed: speedMatch ? speedMatch[1] : '',
          bitrate: bitrateMatch ? bitrateMatch[1] : '',
        })
      }
    })

    proc.on('close', (code) => {
      activeConversions.delete(fileId)

      if (code === 0) {
        // Get output file size
        try {
          const stat = fs.statSync(outputPath)
          mainWindow?.webContents.send('conversion-progress', {
            fileId, progress: 100,
          })
          resolve({ success: true, outputPath, size: stat.size })
        } catch (e) {
          resolve({ success: true, outputPath })
        }
      } else {
        const errorMsg = stderr.split('\n').filter(l => l.includes('Error') || l.includes('error')).join('\n') || 'Conversion failed'
        resolve({ success: false, error: errorMsg })
      }
    })

    proc.on('error', (err) => {
      activeConversions.delete(fileId)
      resolve({ success: false, error: err.message })
    })
  })
})

// Cancel conversion
ipcMain.handle('cancel-conversion', async (event, fileId) => {
  const proc = activeConversions.get(fileId)
  if (proc) {
    proc.kill('SIGKILL')
    activeConversions.delete(fileId)
    return { success: true }
  }
  return { success: false, error: 'Process not found' }
})

// Open file in system explorer
ipcMain.handle('reveal-in-explorer', async (event, filePath) => {
  shell.showItemInFolder(filePath)
  return true
})

// Get default output directory (Downloads folder)
ipcMain.handle('get-downloads-dir', async () => {
  return app.getPath('downloads')
})

// Window controls (for non-darwin custom titlebar)
ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window-close', () => mainWindow?.close())

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getAudioBitrate(quality) {
  switch (quality) {
    case 'low':    return '128k'
    case 'medium': return '192k'
    case 'high':   return '320k'
    default:       return '192k'
  }
}

function getX264Preset(quality) {
  switch (quality) {
    case 'low':    return 'ultrafast'
    case 'medium': return 'medium'
    case 'high':   return 'slow'
    default:       return 'medium'
  }
}

function getCRF(quality) {
  switch (quality) {
    case 'low':    return '28'
    case 'medium': return '23'
    case 'high':   return '18'
    default:       return '23'
  }
}
