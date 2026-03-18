    function getDecalTexture(style, variant) {
        if (!TEXTURE_POLICY.decals) return null;
        const key = `${style.name}-${variant}`;
        if (decalCache.has(key)) return decalCache.get(key);
        const tex = makeLinearCanvasTexture((g, w, h) => {
            g.clearRect(0, 0, w, h);
            g.fillStyle = 'rgba(0,0,0,0)';
            g.fillRect(0, 0, w, h);
            const stain = shadeHex(style.trim, -40);
            for (let i = 0; i < 18; i++) {
                const x = (i * 23 + variant * 37) % w;
                const y = (i * 17 + variant * 29) % h;
                const r = 4 + ((i + variant) % 9);
                g.globalAlpha = 0.05 + ((i % 4) * 0.03);
                g.fillStyle = stain;
                g.beginPath();
                g.arc(x, y, r, 0, Math.PI * 2);
                g.fill();
            }
            g.globalAlpha = 0.14;
            g.strokeStyle = shadeHex(style.trim, -56);
            g.lineWidth = 1;
            for (let i = 0; i < 8; i++) {
                const x = (i * 31 + variant * 7) % w;
                const y = (i * 19 + variant * 13) % h;
                g.beginPath();
                g.moveTo(x, y);
                g.lineTo(x + 10, y + 3);
                g.stroke();
            }
            g.globalAlpha = 1;
        }, 96, 96);
        decalCache.set(key, tex);
        return tex;
    }

    function placeAgingDecals(root) {
