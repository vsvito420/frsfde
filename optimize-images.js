// run "node .\optimize-images.js" to optimize all images in the "assets-unoptimized" folder and save them in "assets-optimized" as WebP with max width 1600px and quality 72.      

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const INPUT_DIR = path.join(__dirname, "assets-unoptimized");
const OUTPUT_DIR = path.join(__dirname, "assets");
const VALID_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let files = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(await walk(fullPath));
        } else {
            files.push(fullPath);
        }
    }

    return files;
}

async function ensureDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
}

async function processImage(file) {
    const ext = path.extname(file).toLowerCase();
    if (!VALID_EXT.has(ext)) return;

    const relativePath = path.relative(INPUT_DIR, file);
    const outputSubdir = path.join(OUTPUT_DIR, path.dirname(relativePath));
    const outputName = path.basename(file, ext) + ".webp";
    const outputPath = path.join(outputSubdir, outputName);

    await ensureDir(outputSubdir);

    const image = sharp(file);
    const metadata = await image.metadata();

    let pipeline = sharp(file).rotate();

    if (metadata.width && metadata.width > 1600) {
        pipeline = pipeline.resize({
            width: 1600,
            withoutEnlargement: true
        });
    }

    await pipeline
        .webp({
            quality: 72
        })
        .toFile(outputPath);

    console.log(`OK: ${relativePath} -> ${path.relative(__dirname, outputPath)}`);
}

async function main() {
    if (!fs.existsSync(INPUT_DIR)) {
        console.error("Ordner 'assets' nicht gefunden.");
        process.exit(1);
    }

    const files = await walk(INPUT_DIR);
    const imageFiles = files.filter(file => VALID_EXT.has(path.extname(file).toLowerCase()));

    if (imageFiles.length === 0) {
        console.log("Keine Bilder gefunden.");
        return;
    }

    for (const file of imageFiles) {
        try {
            await processImage(file);
        } catch (err) {
            console.error(`Fehler bei ${file}:`, err.message);
        }
    }

    console.log("Fertig.");
}

main();