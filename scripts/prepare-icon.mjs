import sharp from "sharp";

await sharp("build/icon.svg").resize(512, 512).png().toFile("build/icon.png");
console.log("Generated build/icon.png");
