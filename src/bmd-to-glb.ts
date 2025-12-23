import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import * as THREE from 'three';
import { BMDLoader } from './bmd-loader';
import { GLTFExporter } from './exporter';
import { convertOzjToBuffer, convertTgaToBuffer, convertOzjToDataUrl, convertTgaToDataUrl } from './ozj-loader-node';

async function convertBmdToGlb(inputPath: string, outputPath: string): Promise<void> {
    const buffer = new Uint8Array(fs.readFileSync(inputPath)).buffer;
    const loader = new BMDLoader();
    const { group, requiredTextures } = await loader.load(buffer);
    group.name = 'bmd_model';

    // Search for textures in the input directory
    const inputDir = path.dirname(inputPath);
    const foundTextures = searchTextures(inputDir, requiredTextures);

    // Load and apply textures
    if (Object.keys(foundTextures).length > 0) {
        for (const textureName in foundTextures) {
            const texturePaths = foundTextures[textureName];
            const texturePath = texturePaths[0];
            await loadAndApplyTexture(group, texturePath);
        }
    }

    const exporter = new GLTFExporter();
    const glbBuffer = await new Promise<ArrayBuffer>((resolve) => {
        exporter.parse(group, (result) => {
            resolve(result as ArrayBuffer);
        }, (error)=>{
            console.error('GLTFExporter error', error);
        }, { binary: true, embedImages: true, animations: group.animations, });
    });

    fs.writeFileSync(outputPath, Buffer.from(glbBuffer));
    console.log(`Converted ${inputPath} to ${outputPath}`);
}

function findBmdFiles(dir: string): string[] {
    const files: string[] = [];

    function traverse(current: string): void {
        const items = fs.readdirSync(current);
        for (const item of items) {
            const full = path.join(current, item);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
                traverse(full);
            } else if (path.extname(item).toLowerCase() === '.bmd') {
                files.push(full);
            }
        }
    }

    traverse(dir);
    return files;
}

function searchTextures(startPath: string, requiredTextures: string[]): { [key: string]: string[] } {
    const foundTextures: { [key: string]: string[] } = {};
    const validExtensions = ['.jpg', '.jpeg', '.png', '.tga', '.ozj', '.ozt'];

    // Normalize required texture names (remove extension, lowercase)
    const requiredNames = requiredTextures.map(tex => {
        const basename = path.basename(tex, path.extname(tex)).toLowerCase();
        return basename;
    });

    function searchDir(dirPath: string, depth = 0): void {
        if (depth > 3) return;

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    // Recursively search subdirectories
                    searchDir(fullPath, depth + 1);
                } else if (entry.isFile()) {
                    const lowerName = entry.name.toLowerCase();
                    const ext = path.extname(lowerName);
                    if (validExtensions.includes(ext)) {
                        const nameWithoutExt = path.basename(lowerName, ext);

                        // Check if this texture is required
                        if (requiredNames.includes(nameWithoutExt)) {
                            // Add ALL files with matching base name (not just first one)
                            if (!foundTextures[nameWithoutExt]) {
                                foundTextures[nameWithoutExt] = [];
                            }
                            foundTextures[nameWithoutExt].push(fullPath);
                        }
                    }
                }
            }
        } catch (error) {
            // Ignore permission errors, etc.
        }
    }

    searchDir(startPath);

    return foundTextures;
}

async function loadAndApplyTexture(group: THREE.Group, filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    let tex: THREE.Texture<any>;
    
    const buffer = fs.readFileSync(filePath);
    
    if (ext === '.tga') {
        const { buffer: rgbaBuffer, width, height } = await convertTgaToBuffer(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        tex = new THREE.DataTexture(new Uint8Array(rgbaBuffer), width, height, THREE.RGBAFormat);
        const dataUrl = await convertTgaToDataUrl(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        tex.image.src = dataUrl;
        tex.needsUpdate = true;
    } else if (ext === '.ozj' || ext === '.ozt') {
        const { buffer: rgbaBuffer, width, height } = await convertOzjToBuffer(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        tex = new THREE.DataTexture(new Uint8Array(rgbaBuffer), width, height, THREE.RGBAFormat);
        const dataUrl = await convertOzjToDataUrl(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        tex.image.src = dataUrl;
        tex.needsUpdate = true;
    } else {
        const img = sharp(buffer);
        const rawBuffer = await img.ensureAlpha().raw().toBuffer();
        const metadata = await img.metadata();
        tex = new THREE.DataTexture(new Uint8Array(rawBuffer), metadata.width!, metadata.height!, THREE.RGBAFormat);
        const mime = ext === '.jpg' ? 'jpeg' : 'png';
        const dataUrl = 'data:image/' + mime + ';base64,' + buffer.toString('base64');
        (tex.image as any).src = dataUrl;
        tex.needsUpdate = true;
    }
    
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = false;
    tex.name = path.basename(filePath);
    
    const equivExt: Record<string,string[]> = {
        jpg:  ['ozj', 'jpeg'],
        jpeg: ['ozj', 'jpg'],
        ozj:  ['jpg', 'jpeg', 'png'],
        png:  ['ozj', 'ozt'],
        tga:  ['ozt', 'png'],
        ozt:  ['tga', 'png'],
    };
    
    const fileName = path.basename(filePath);
    const fileBase = fileName.toLowerCase().replace(/\.[^.]+$/, '');
    const fileExt = ext.slice(1);
    
    function normalizeWanted(path: string): { base:string; ext:string } {
        const name = path.split(/[\\/]/).pop()!.toLowerCase();
        const ext  = name.split('.').pop()!;
        const base = name.replace(/\.[^.]+$/, '');
        return { base, ext };
    }
    
    const meshList: { mesh: THREE.Mesh; path: string; isMatch: boolean }[] = [];
    group.traverse(obj => {
        if ((obj as THREE.Mesh).isMesh && obj.userData.texturePath) {
            const wantedPath = obj.userData.texturePath as string;
            const { base:wantedBase, ext:wantedExt } = normalizeWanted(wantedPath);
            const extMatch =
                wantedExt === fileExt ||
                (equivExt[wantedExt]?.includes(fileExt)) ||
                (equivExt[fileExt]?.includes(wantedExt));
            const isMatch = extMatch && wantedBase === fileBase;
            meshList.push({ mesh: obj as THREE.Mesh, path: wantedPath, isMatch });
        }
    });
    
    if (fileExt === 'ozj' || fileExt === 'ozt') {
        let applied = false;
        meshList.forEach(m => {
            if (m.isMatch) {
                const mat = m.mesh.material as THREE.MeshPhongMaterial;
                if (mat.map) mat.map.dispose();
                mat.map = tex;
                mat.color.set(0xffffff);
                if (fileExt === 'ozt') {
                    mat.transparent = true;
                    mat.blending = THREE.NormalBlending;
                    mat.depthWrite = false;
                } else {
                    mat.transparent = false;
                    mat.blending = THREE.NoBlending;
                    mat.depthWrite = true;
                }
                mat.needsUpdate = true;
                applied = true;
            }
        });
        
        if (!applied) {
            console.warn(`No matching mesh found for "${fileName}"`);
        }
        
    } else {
        let applied = false;
        meshList.forEach(m => {
            if (m.isMatch) {
                const mat = m.mesh.material as THREE.MeshPhongMaterial;
                if (mat.map) mat.map.dispose();
                mat.map = tex;
                mat.color.set(0xffffff);
                mat.needsUpdate = true;
                applied = true;
            }
        });
        
        if (!applied) {
            console.warn(`No matching mesh found for "${fileName}"`);
        }
    }
}

async function loadAndApplyTextures(group: THREE.Group, foundTextures: { [key: string]: string[] }): Promise<void> {

    // Process each found texture
    for (const [textureName, texturePaths] of Object.entries(foundTextures)) {
        // Use the first matching file for each texture name
        const texturePath = texturePaths[0];
        const ext = path.extname(texturePath).toLowerCase();

        let texture: THREE.Texture;
        try {
            if (ext === '.tga') {
                const tgaBuffer = fs.readFileSync(texturePath);
                const { buffer, width, height } = await convertTgaToBuffer(tgaBuffer.buffer.slice(tgaBuffer.byteOffset, tgaBuffer.byteOffset + tgaBuffer.byteLength));
                texture = new THREE.DataTexture(new Uint8Array(buffer), width, height, THREE.RGBAFormat);
                texture.needsUpdate = true;
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.flipY = false;
            } else if (ext === '.ozj' || ext === '.ozt') {
                const ozjBuffer = fs.readFileSync(texturePath);
                const { buffer, width, height } = await convertOzjToBuffer(ozjBuffer.buffer.slice(ozjBuffer.byteOffset, ozjBuffer.byteOffset + ozjBuffer.byteLength));
                texture = new THREE.DataTexture(new Uint8Array(buffer), width, height, THREE.RGBAFormat);
                texture.needsUpdate = true;
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.flipY = false;
            } else {
                // jpg / png
                const imgBuffer = fs.readFileSync(texturePath);
                const img = sharp(imgBuffer);
                const rawBuffer = await img.ensureAlpha().raw().toBuffer();
                const metadata = await img.metadata();
                texture = new THREE.DataTexture(new Uint8Array(rawBuffer), metadata.width!, metadata.height!, THREE.RGBAFormat);
                texture.needsUpdate = true;
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.flipY = false;
            }

            texture.colorSpace = THREE.SRGBColorSpace;
            texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            texture.flipY = false;
            texture.name = path.basename(texturePath);

            // Apply texture to matching meshes
            applyTextureToMeshes(group, textureName, texture);
        } catch (error) {
            console.error(`Failed to load texture ${texturePath}:`, error);
        }
    }
}

function applyTextureToMeshes(group: THREE.Group, textureName: string, texture: THREE.Texture): void {
    group.traverse(obj => {
        if ((obj as THREE.Mesh).isMesh && obj.userData.texturePath) {
            const mesh = obj as THREE.Mesh;
            const wantedPath = obj.userData.texturePath as string;
            const wantedBase = path.basename(wantedPath, path.extname(wantedPath)).toLowerCase();

            if (wantedBase === textureName) {
                const mat = mesh.material as THREE.MeshStandardMaterial;
                if (mat.map) mat.map.dispose();
                mat.map = texture;
                mat.color.set(0xffffff);
                const ext = path.extname(texture.name).toLowerCase();
                if (ext === '.ozt') {
                    // OZT has alpha channel, enable transparency
                    mat.transparent = true;
                    mat.blending = THREE.NormalBlending;
                    mat.depthWrite = false;
                } else {
                    // OZJ (JPEG) typically no alpha
                    mat.transparent = false;
                    mat.blending = THREE.NoBlending;
                    mat.depthWrite = true;
                }
                mat.needsUpdate = true;
            }
        }
    });
}

async function main(): Promise<void> {
    const inputDir = process.argv[2];
    const outputDir = process.argv[3];

    if (!inputDir || !outputDir) {
        console.log('Usage: ts-node src/bmd-to-glb.ts <inputDir> <outputDir>');
        process.exit(1);
    }

    const bmdFiles = findBmdFiles(inputDir);

    for (const bmdFile of bmdFiles) {
        const relativePath = path.relative(inputDir, bmdFile);
        const outputFile = path.join(outputDir, relativePath.replace(/\.bmd$/i, '.glb'));
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });

        try {
            await convertBmdToGlb(bmdFile, outputFile);
            console.log(`Converted ${bmdFile}`);
        } catch (e) {
            console.error(`Failed to convert ${bmdFile}:`, e);
        }
    }

    console.log('Conversion complete');
}

main().catch(console.error);