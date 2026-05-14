import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import * as THREE from 'three';
import { BMDLoader } from './bmd-loader';
import { GLTFExporter } from './exporter';
import { convertOzjToBuffer, convertTgaToBuffer } from './ozj-loader-node';
import { pMap } from './batch-utils';

async function convertBmdToGlb(inputPath: string, outputPath: string): Promise<void> {
    const buffer = new Uint8Array(fs.readFileSync(inputPath)).buffer;
    const loader = new BMDLoader();
    const { group, requiredTextures } = await loader.load(buffer);
    group.name = 'bmd_model';

    // Search for textures in the input directory
    const inputDir = path.dirname(inputPath);
    const foundTextures = searchTextures(inputDir, requiredTextures);

    // Load and apply textures in parallel
    if (Object.keys(foundTextures).length > 0) {
        const allTexturePaths = Object.values(foundTextures).flat();
        await Promise.all(allTexturePaths.map(texturePath => loadAndApplyTexture(group, texturePath)));
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
                    searchDir(fullPath, depth + 1);
                } else if (entry.isFile()) {
                    const lowerName = entry.name.toLowerCase();
                    const ext = path.extname(lowerName);
                    if (validExtensions.includes(ext)) {
                        const nameWithoutExt = path.basename(lowerName, ext);

                        if (requiredNames.includes(nameWithoutExt)) {
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
        const tgaBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        const { buffer: rgbaBuffer, width, height } = await convertTgaToBuffer(tgaBuffer);
        tex = new THREE.DataTexture(new Uint8Array(rgbaBuffer), width, height, THREE.RGBAFormat);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.flipY = false;
        tex.name = path.basename(filePath);
        tex.needsUpdate = true;
    } else if (ext === '.ozj' || ext === '.ozt') {
        const ozjBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        const { buffer: rgbaBuffer, width, height } = await convertOzjToBuffer(ozjBuffer);
        tex = new THREE.DataTexture(new Uint8Array(rgbaBuffer), width, height, THREE.RGBAFormat);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.flipY = false;
        tex.name = path.basename(filePath);
        tex.needsUpdate = true;
    } else {
        const img = sharp(buffer);
        const metadata = await img.metadata();
        const rawBuffer = await img.ensureAlpha().raw().toBuffer();
        tex = new THREE.DataTexture(new Uint8Array(rawBuffer), metadata.width!, metadata.height!, THREE.RGBAFormat);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.flipY = false;
        tex.name = path.basename(filePath);
        tex.needsUpdate = true;
    }

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

    function normalizeWanted(p: string): { base:string; ext:string } {
        const name = p.split(/[\\/]/).pop()!.toLowerCase();
        const e = name.split('.').pop()!;
        const b = name.replace(/\.[^.]+$/, '');
        return { base: b, ext: e };
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
}

async function main(): Promise<void> {
    const inputDir = process.argv[2];
    const outputDir = process.argv[3];
    const concurrency = parseInt(process.argv[4], 10) || 16;

    if (!inputDir || !outputDir) {
        console.log('Usage: ts-node src/bmd-to-glb.ts <inputDir> <outputDir> [concurrency=4]');
        process.exit(1);
    }

    const bmdFiles = findBmdFiles(inputDir);
    console.log(`Found ${bmdFiles.length} BMD files. Processing with concurrency=${concurrency}...`);

    const total = bmdFiles.length;
    let completed = 0;
    let failed = 0;

    await pMap(bmdFiles, async (bmdFile) => {
        const relativePath = path.relative(inputDir, bmdFile);
        const outputFile = path.join(outputDir, relativePath.replace(/\.bmd$/i, '.glb'));
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });

        try {
            await convertBmdToGlb(bmdFile, outputFile);
            completed++;
            console.log(`[${completed}/${total}] Converted ${bmdFile}`);
        } catch (e) {
            failed++;
            console.error(`[${completed + failed}/${total}] Failed to convert ${bmdFile}:`, e);
        }
    }, concurrency);

    console.log(`Conversion complete: ${completed} succeeded, ${failed} failed`);
}

main().catch(console.error);
