const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const app = express();

// Lista de videos de YouTube
const videoUrls = [
    'https://youtu.be/BR3NFEXuSv0?si=mSCaAzM4r6NjbC5L',
    'https://youtu.be/XOt3Rgs-tt0?si=RU86-8VqLKJ3TH60',
    'https://youtu.be/nD2TZahdAJY?si=3DfZBqXeEhAsgQH8',
    'https://youtu.be/lKgDhWCEfQo?si=6mD0EbDePrs_EAiI',
    'https://youtu.be/4uwZ-80XAqw?si=b62G5uNlWCdHBcnT',
    'https://youtu.be/NRQ7Kv7-8Hs?si=kFxtzMTvOwVFRx84',
    'https://youtu.be/rzDrGSWteZg?si=CqsE3ffZU5H0Mnyg'
];

const SRT_ENDPOINT = 'srt://rtmp.livepeer.com:2935?streamid=95e4-urol-igfh-cehi';
const DOWNLOAD_DIR = './downloads';
const ASSETS_DIR = './assets';

// URLs de los assets
const LOGO_URL = 'https://files.catbox.moe/y7nudl.png';
const LOADING_SCREEN_URL = 'https://files.catbox.moe/wuo1sz.png';

// Variables de estado
let isStreaming = false;
let currentVideoIndex = 0;
let streamingProcess = null;

// Crear directorios si no existen
[DOWNLOAD_DIR, ASSETS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Función para descargar assets (logo y pantalla de carga)
async function downloadAssets() {
    try {
        console.log('Descargando assets...');
        
        // Descargar logo
        const logoPath = path.join(ASSETS_DIR, 'logo.png');
        if (!fs.existsSync(logoPath)) {
            const logoResponse = await axios({
                method: 'GET',
                url: LOGO_URL,
                responseType: 'stream'
            });
            const logoWriter = fs.createWriteStream(logoPath);
            logoResponse.data.pipe(logoWriter);
            await new Promise((resolve, reject) => {
                logoWriter.on('finish', resolve);
                logoWriter.on('error', reject);
            });
            console.log('Logo descargado');
        }
        
        // Descargar pantalla de carga
        const loadingPath = path.join(ASSETS_DIR, 'loading.png');
        if (!fs.existsSync(loadingPath)) {
            const loadingResponse = await axios({
                method: 'GET',
                url: LOADING_SCREEN_URL,
                responseType: 'stream'
            });
            const loadingWriter = fs.createWriteStream(loadingPath);
            loadingResponse.data.pipe(loadingWriter);
            await new Promise((resolve, reject) => {
                loadingWriter.on('finish', resolve);
                loadingWriter.on('error', reject);
            });
            console.log('Pantalla de carga descargada');
        }
        
        return { logoPath, loadingPath };
    } catch (error) {
        console.error('Error descargando assets:', error);
        return null;
    }
}

// Función para mostrar pantalla de carga
async function showLoadingScreen(loadingPath) {
    return new Promise((resolve, reject) => {
        console.log('Mostrando pantalla de carga...');
        
        const loadingProcess = spawn('ffmpeg', [
            '-loop', '1',                   // Loop de la imagen
            '-i', loadingPath,              // Imagen de carga
            '-c:v', 'libx264',              // Codec de video
            '-preset', 'ultrafast',         // Preset rápido
            '-tune', 'zerolatency',         // Optimizar para latencia baja
            '-r', '30',                     // 30 FPS
            '-s', '1920x1080',              // Resolución
            '-pix_fmt', 'yuv420p',          // Formato de pixel
            '-f', 'mpegts',                 // Formato de salida
            SRT_ENDPOINT                    // Destino SRT
        ]);
        
        loadingProcess.stderr.on('data', (data) => {
            // Silenciar logs de FFmpeg para pantalla de carga
        });
        
        // Resolver después de 3 segundos para permitir que se muestre
        setTimeout(() => {
            if (loadingProcess && !loadingProcess.killed) {
                loadingProcess.kill('SIGTERM');
            }
            resolve();
        }, 3000);
        
        loadingProcess.on('error', (error) => {
            console.error('Error en pantalla de carga:', error);
            reject(error);
        });
    });
}

// Función para extraer video ID de URL de YouTube
function extractVideoId(url) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([^&\n?#]+)/);
    return match ? match[1] : null;
}

// Función para descargar video usando la API de Vreden
async function downloadVideo(youtubeUrl) {
    try {
        console.log(`Descargando: ${youtubeUrl}`);
        
        const apiUrl = `https://api.vreden.my.id/api/ytmp4?url=${encodeURIComponent(youtubeUrl)}`;
        const response = await axios.get(apiUrl, { timeout: 30000 });
        
        if (response.data.status === 200 && response.data.result.download.status) {
            const videoData = response.data.result;
            const downloadUrl = videoData.download.url;
            const filename = `${videoData.metadata.videoId}.mp4`;
            const filepath = path.join(DOWNLOAD_DIR, filename);
            
            // Descargar el archivo de video
            const videoResponse = await axios({
                method: 'GET',
                url: downloadUrl,
                responseType: 'stream',
                timeout: 60000
            });
            
            const writer = fs.createWriteStream(filepath);
            videoResponse.data.pipe(writer);
            
            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    console.log(`✅ Video descargado: ${filename}`);
                    resolve({
                        filepath,
                        metadata: videoData.metadata
                    });
                });
                writer.on('error', reject);
            });
        } else {
            throw new Error('Error en la API de Vreden');
        }
    } catch (error) {
        console.error(`❌ Error descargando ${youtubeUrl}:`, error.message);
        return null;
    }
}

// Función para transmitir video con logo overlay
async function streamVideoWithLogo(videoPath, logoPath) {
    return new Promise((resolve, reject) => {
        console.log(`🔴 Transmitiendo: ${path.basename(videoPath)}`);
        
        // FFmpeg con overlay del logo en la esquina inferior derecha
        const ffmpegArgs = [
            '-re',                          // Leer entrada a velocidad nativa
            '-i', videoPath,               // Video principal
            '-i', logoPath,                // Logo
            '-filter_complex', 
            '[1:v]scale=120:80[logo];[0:v][logo]overlay=W-w-20:H-h-20', // Logo pequeño en esquina inferior derecha
            '-c:v', 'libx264',             // Codec de video
            '-preset', 'ultrafast',        // Preset rápido
            '-tune', 'zerolatency',        // Optimizar para latencia baja
            '-c:a', 'aac',                 // Codec de audio
            '-b:v', '2500k',               // Bitrate de video
            '-b:a', '128k',                // Bitrate de audio
            '-r', '30',                    // 30 FPS
            '-s', '1920x1080',             // Resolución de salida
            '-pix_fmt', 'yuv420p',         // Formato de pixel
            '-f', 'mpegts',                // Formato de salida
            SRT_ENDPOINT                   // Destino SRT
        ];
        
        streamingProcess = spawn('ffmpeg', ffmpegArgs);
        
        streamingProcess.stdout.on('data', (data) => {
            // Silenciar stdout para logs más limpios
        });
        
        streamingProcess.stderr.on('data', (data) => {
            const output = data.toString();
            // Solo mostrar información importante
            if (output.includes('frame=') || output.includes('fps=')) {
                // Mostrar progreso cada 100 frames
                const frameMatch = output.match(/frame=\s*(\d+)/);
                if (frameMatch && parseInt(frameMatch[1]) % 100 === 0) {
                    console.log(`📺 Transmitiendo frame: ${frameMatch[1]}`);
                }
            }
        });
        
        streamingProcess.on('close', (code) => {
            console.log(`✅ Transmisión terminada con código: ${code}`);
            streamingProcess = null;
            resolve(code);
        });
        
        streamingProcess.on('error', (error) => {
            console.error('❌ Error en streaming:', error);
            streamingProcess = null;
            reject(error);
        });
    });
}

// Función principal para transmisión 24/7
async function start24x7Streaming() {
    console.log('🚀 Iniciando transmisión 24/7...');
    
    // Descargar assets primero
    const assets = await downloadAssets();
    if (!assets) {
        console.error('❌ No se pudieron descargar los assets');
        return;
    }
    
    isStreaming = true;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;
    
    while (isStreaming) {
        try {
            const currentUrl = videoUrls[currentVideoIndex];
            console.log(`\n🎬 === Video ${currentVideoIndex + 1}/${videoUrls.length} ===`);
            console.log(`URL: ${currentUrl}`);
            
            // Mostrar pantalla de carga mientras se descarga
            const loadingPromise = showLoadingScreen(assets.loadingPath);
            const downloadPromise = downloadVideo(currentUrl);
            
            // Esperar a que termine la pantalla de carga
            await loadingPromise;
            
            // Obtener el video descargado
            const videoInfo = await downloadPromise;
            
            if (videoInfo) {
                // Transmitir video con logo
                try {
                    await streamVideoWithLogo(videoInfo.filepath, assets.logoPath);
                    consecutiveErrors = 0; // Reset contador de errores
                } catch (streamError) {
                    console.error('❌ Error en streaming:', streamError);
                    consecutiveErrors++;
                }
                
                // Limpiar archivo después de transmitir
                try {
                    fs.unlinkSync(videoInfo.filepath);
                    console.log(`🗑️ Archivo eliminado: ${path.basename(videoInfo.filepath)}`);
                } catch (err) {
                    console.error('❌ Error eliminando archivo:', err);
                }
            } else {
                console.log('⚠️ Video no pudo ser descargado, continuando...');
                consecutiveErrors++;
                
                // Si no se pudo descargar, mostrar pantalla de carga por más tiempo
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
            
            // Si hay muchos errores consecutivos, pausar un poco
            if (consecutiveErrors >= maxConsecutiveErrors) {
                console.log(`⚠️ Demasiados errores consecutivos (${consecutiveErrors}), pausando por 30 segundos...`);
                await new Promise(resolve => setTimeout(resolve, 30000));
                consecutiveErrors = 0;
            }
            
            // Pasar al siguiente video (loop infinito)
            currentVideoIndex = (currentVideoIndex + 1) % videoUrls.length;
            
            if (currentVideoIndex === 0) {
                console.log('🔄 Playlist completado, reiniciando...');
            }
            
            // Pequeña pausa entre videos
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            console.error('❌ Error en el bucle principal:', error);
            consecutiveErrors++;
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// Función para detener streaming
function stopStreaming() {
    console.log('🛑 Deteniendo transmisión...');
    isStreaming = false;
    if (streamingProcess && !streamingProcess.killed) {
        streamingProcess.kill('SIGTERM');
        streamingProcess = null;
    }
}

// Rutas de la API
app.get('/', (req, res) => {
    res.json({
        status: 'YouTube to SRT 24/7 Streaming Server',
        isStreaming: isStreaming,
        currentVideo: currentVideoIndex + 1,
        totalVideos: videoUrls.length,
        endpoint: SRT_ENDPOINT,
        features: [
            'Transmisión 24/7',
            'Logo overlay',
            'Pantalla de carga',
            'Playlist infinito'
        ]
    });
});

app.get('/start', async (req, res) => {
    if (isStreaming) {
        res.json({ message: 'La transmisión ya está activa' });
    } else {
        res.json({ message: 'Iniciando transmisión 24/7...' });
        start24x7Streaming().catch(console.error);
    }
});

app.get('/stop', (req, res) => {
    stopStreaming();
    res.json({ message: 'Transmisión detenida' });
});

app.get('/status', (req, res) => {
    res.json({
        status: isStreaming ? 'streaming' : 'stopped',
        currentVideo: {
            index: currentVideoIndex + 1,
            total: videoUrls.length,
            url: videoUrls[currentVideoIndex]
        },
        endpoint: SRT_ENDPOINT,
        uptime: process.uptime(),
        assets: {
            logo: LOGO_URL,
            loading: LOADING_SCREEN_URL
        }
    });
});

app.get('/playlist', (req, res) => {
    res.json({
        current: currentVideoIndex,
        videos: videoUrls.map((url, index) => ({
            index: index + 1,
            url: url,
            active: index === currentVideoIndex
        }))
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
    console.log(`📡 Endpoint SRT: ${SRT_ENDPOINT}`);
    console.log(`🎵 Videos en playlist: ${videoUrls.length}`);
    console.log(`🎨 Logo: ${LOGO_URL}`);
    console.log(`⏳ Pantalla de carga: ${LOADING_SCREEN_URL}`);
    
    // Iniciar transmisión automáticamente
    console.log('\n⏰ Iniciando transmisión 24/7 en 5 segundos...');
    setTimeout(() => {
        start24x7Streaming().catch(console.error);
    }, 5000);
});

// Manejo graceful de cierre
process.on('SIGINT', () => {
    console.log('\n🛑 Recibida señal de interrupción...');
    stopStreaming();
    setTimeout(() => {
        process.exit(0);
    }, 2000);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Recibida señal de terminación...');
    stopStreaming();
    setTimeout(() => {
        process.exit(0);
    }, 2000);
});

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
    // No cerrar el proceso, solo logear
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
    // No cerrar el proceso, solo logear
});
