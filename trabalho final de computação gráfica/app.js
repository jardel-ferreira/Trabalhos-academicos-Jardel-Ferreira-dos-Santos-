window.onload = function() {
    if (typeof m4 === 'undefined') { 
        document.getElementById('errorMsg').innerHTML = '<p class="error">Erro: m4.js não carregou. Verifique sua conexão.</p>';
        return; 
    }
    main();
};


// 1. SHADERS 

const vs = `
attribute vec4 a_position;
attribute vec3 a_normal;

uniform mat4 u_matrix;
uniform mat4 u_world;
uniform vec3 u_viewWorldPosition;

varying vec3 v_normal;
varying vec3 v_surfaceToView;
varying vec3 v_surfaceWorldPosition;
varying float v_height;

void main() {
  gl_Position = u_matrix * a_position;
  v_surfaceWorldPosition = (u_world * a_position).xyz;
  v_normal = mat3(u_world) * a_normal;
  v_surfaceToView = u_viewWorldPosition - v_surfaceWorldPosition;
  v_height = a_position.y; 
}
`;

const fs = `
precision mediump float;

varying vec3 v_normal;
varying vec3 v_surfaceToView;
varying vec3 v_surfaceWorldPosition;
varying float v_height;

uniform vec4 u_color;
uniform vec3 u_lightDir; 

// Luzes
uniform vec3 u_noseLightPos; 
uniform vec3 u_noseLightColor;

// Luzes dos Itens
uniform vec3 u_itemLightPos1;
uniform vec3 u_itemLightColor1;
uniform vec3 u_itemLightPos2;
uniform vec3 u_itemLightColor2;

uniform float u_emissive; 
uniform float u_isTerrain; 

vec3 calculatePointLight(vec3 normal, vec3 pos, vec3 color, float intensity, float radius) {
    vec3 surfaceToLight = pos - v_surfaceWorldPosition;
    float distance = length(surfaceToLight);
    vec3 pointLightDir = normalize(surfaceToLight);
    float attenuation = 1.0 / (1.0 + (2.0/radius) * distance + (1.0/(radius*radius)) * distance * distance);
    float amount = max(dot(normal, pointLightDir), 0.0);
    return color * amount * attenuation * intensity;
}

void main() {
  vec3 normal = normalize(v_normal);
  vec3 baseColor = u_color.rgb;
  
  if (u_isTerrain > 1.5) {
      float snowLine = smoothstep(1.5, 4.0, v_height); 
      vec3 rockColor = u_color.rgb;
      vec3 snowColor = vec3(0.95, 0.95, 1.0);
      baseColor = mix(rockColor, snowColor, snowLine);
  }

  float light = dot(normal, u_lightDir) * 0.5 + 0.4; 
  vec3 noseLight = calculatePointLight(normal, u_noseLightPos, u_noseLightColor, 1.5, 15.0);
  vec3 itemLight1 = calculatePointLight(normal, u_itemLightPos1, u_itemLightColor1, 2.0, 20.0);
  vec3 itemLight2 = calculatePointLight(normal, u_itemLightPos2, u_itemLightColor2, 2.0, 20.0);

  vec3 finalColor = baseColor * light + noseLight + itemLight1 + itemLight2;
  finalColor += u_color.rgb * u_emissive; 

  gl_FragColor = vec4(finalColor, u_color.a);
}
`;

function createProgram(gl, vsSource, fsSource) {
    const createShader = (gl, type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
        return s;
    }
    const p = gl.createProgram();
    gl.attachShader(p, createShader(gl, gl.VERTEX_SHADER, vsSource));
    gl.attachShader(p, createShader(gl, gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(p);
    return p;
}


// 2. CORES

function rgb(r, g, b) { return [r/255, g/255, b/255, 1.0]; }

const Colors = {
    RED: rgb(180, 20, 20),
    GOLD: rgb(255, 215, 0),
    WOOD: rgb(101, 67, 33),
    SEAT: rgb(60, 20, 20),
    SKIN: rgb(255, 204, 170),
    WHITE: rgb(255, 255, 255),
    BLACK: rgb(20, 20, 20),
    FUR_L: rgb(139, 69, 19),
    FUR_D: rgb(101, 67, 33),
    ANTLER: rgb(210, 180, 140),
    NOSE_R: rgb(200, 0, 0),
    SNOW: rgb(240, 240, 255),
    DEEP_SNOW: rgb(200, 210, 230),
    CARROT: rgb(255, 100, 0),
    LEAF: rgb(30, 100, 30),
    GIFT_R: rgb(255, 50, 50),
    MOON: rgb(255, 255, 240),
    STAR: rgb(255, 220, 50),
    ICE: rgb(0, 255, 255),
    POWERUP: rgb(255, 215, 0),
    SANTA_RED: rgb(214, 40, 40),
    SANTA_BELT: rgb(30, 30, 30),
    SANTA_GOLD: rgb(255, 215, 0),
    SANTA_WHITE: rgb(240, 240, 240),
    SANTA_SKIN: rgb(255, 204, 170),
    SANTA_BOOT: rgb(20, 20, 20),
    BEAR_FUR: rgb(245, 245, 255),
    BEAR_NOSE: rgb(40, 40, 50),
    MOUNTAIN_ROCK: rgb(60, 55, 65) 
};

// Estado do Jogo
const gameState = {
    baseSpeed: 25.0, // Velocidade 
    speed: 25.0, 
    score: 0,
    playerX: 0,
    playerY: 0,
    yVelocity: 0,
    isJumping: false,
    hit: false,
    time: 0,
    hasSled: false,
    canShoot: false,
    lastShotTime: 0,
    
    // ESTADO DO URSO
    isBeingChased: false, 
    bearProximity: 0, // 0 = Longe, 100 = Pegou
    bearChaseTimer: 0, // Quanto tempo o urso está correndo
    gameOver: false,
    gameOverReason: ""
};

// Cenário
let scenery = [];
let bullets = []; 
const NUM_OBJECTS = 60; 

// Estrekas fundo
const stars = [];
for(let i=0; i<100; i++) {
    stars.push({
        x: (Math.random() - 0.5) * 400, 
        y: 50 + Math.random() * 100,    
        z: -100 - Math.random() * 200,  
        size: 0.5 + Math.random() * 0.5 
    });
}

function spawnObject(zPos) {
    let type, xPos;
    let dx = 0; 
    let special = false; 
    const rand = Math.random();
    
    // arvores ou montanhas nas laterais
    if (Math.random() > 0.4) {
        if (Math.random() > 0.5) type = 'tree';
        else type = 'hill'; 
        
        const side = Math.random() > 0.5 ? 1 : -1;
        xPos = side * (12 + Math.random() * 25); 
    } else {
        // Objetos de Gameplay no centro
        xPos = (Math.random() - 0.5) * 16; 
        
        // ITENS ESPECIAIS    ---(obs: incluir a estrela dps)
        if (!gameState.hasSled && rand > 0.96) {
            type = 'sled_pickup'; 
            special = true;
        } else if (gameState.hasSled && rand > 0.94) {
             if (Math.random() > 0.5) type = 'star_powerup';
             else type = 'shoot_powerup';
             special = true;
        } 
        else if (rand > 0.90) { 
            type = 'walking_bear';
            dx = (Math.random() < 0.5 ? 1 : -1) * (3 + Math.random() * 4);
        } else if (rand > 0.82) { 
            type = 'villain'; 
        } else if (rand > 0.55) { 
            type = 'rock'; 
        } else if (rand > 0.40) { 
            type = 'gift'; 
        } else {
            type = 'rock'; 
        }
    }

    return {
        x: xPos, 
        z: zPos, 
        type: type, 
        scale: special ? 1.5 : (0.8 + Math.random() * 0.4), 
        active: true,
        rot: Math.random() * Math.PI,
        dx: dx,
        isSpecial: special
    };
}

for(let i=0; i<NUM_OBJECTS; i++) {
    scenery.push(spawnObject(-Math.random() * 350 - 50));
}

// entradas do usuário
const keys = {};
window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);

function bindTouch(id, key) {
    const el = document.getElementById(id);
    el.addEventListener('touchstart', (e) => { e.preventDefault(); keys[key] = true; el.classList.add('active'); });
    el.addEventListener('touchend', (e) => { e.preventDefault(); keys[key] = false; el.classList.remove('active'); });
    el.addEventListener('mousedown', (e) => { e.preventDefault(); keys[key] = true; el.classList.add('active'); });
    el.addEventListener('mouseup', (e) => { e.preventDefault(); keys[key] = false; el.classList.remove('active'); });
    el.addEventListener('mouseleave', (e) => { if(keys[key]) { keys[key] = false; el.classList.remove('active'); } });
}
bindTouch('btnLeft', 'arrowleft');
bindTouch('btnRight', 'arrowright');
bindTouch('btnJump', ' ');
bindTouch('btnShoot', 'f');


// 3. MAIN

function main() {
    const canvas = document.getElementById('glCanvas');
    const gl = canvas.getContext('webgl');
    if (!gl) return;

    const program = createProgram(gl, vs, fs);
    const posLoc = gl.getAttribLocation(program, 'a_position');
    const normLoc = gl.getAttribLocation(program, 'a_normal');
    
    const matrixLoc = gl.getUniformLocation(program, 'u_matrix');
    const worldLoc = gl.getUniformLocation(program, 'u_world');
    const colorLoc = gl.getUniformLocation(program, 'u_color');
    const lightLoc = gl.getUniformLocation(program, 'u_lightDir');
    const viewPosLoc = gl.getUniformLocation(program, 'u_viewWorldPosition');
    
    const noseLightPosLoc = gl.getUniformLocation(program, 'u_noseLightPos');
    const noseLightColorLoc = gl.getUniformLocation(program, 'u_noseLightColor');
    
    const itemLightPos1Loc = gl.getUniformLocation(program, 'u_itemLightPos1');
    const itemLightColor1Loc = gl.getUniformLocation(program, 'u_itemLightColor1');
    const itemLightPos2Loc = gl.getUniformLocation(program, 'u_itemLightPos2');
    const itemLightColor2Loc = gl.getUniformLocation(program, 'u_itemLightColor2');
    
    const emissiveLoc = gl.getUniformLocation(program, 'u_emissive');
    const isTerrainLoc = gl.getUniformLocation(program, 'u_isTerrain');

    // GERADORES GEOMÉTRICOS (primitivas)
    function createIrregularHill(width, height, depth) {
        const cols = 10;
        const rows = 10;
        const positions = [];
        const normals = [];
        const getHillHeight = (x, z) => {
            const dx = x / (width/2);
            const dz = z / (depth/2);
            const dist = Math.sqrt(dx*dx + dz*dz);
            let h = Math.max(0, 1.0 - dist);
            h = Math.pow(h, 0.5) * height; 
            if (h > 0) {
                h += Math.sin(x * 2.0) * 0.5;
                h += Math.cos(z * 1.5) * 0.5;
            }
            return Math.max(0, h);
        };
        for (let z = 0; z <= rows; z++) {
            for (let x = 0; x <= cols; x++) {
                const px = (x / cols - 0.5) * width;
                const pz = (z / rows - 0.5) * depth;
                const py = getHillHeight(px, pz);
                positions.push(px, py, pz);
                let nx = px; let ny = height; let nz = pz;
                let len = Math.sqrt(nx*nx + ny*ny + nz*nz);
                normals.push(nx/len, ny/len, nz/len);
            }
        }
        const indices = [];
        for (let z = 0; z < rows; z++) {
            for (let x = 0; x < cols; x++) {
                const row1 = z * (cols + 1) + x;
                const row2 = (z + 1) * (cols + 1) + x;
                indices.push(row1, row2, row1 + 1);
                indices.push(row1 + 1, row2, row2 + 1);
            }
        }
        const finalPos = [], finalNorm = [];
        for(let i=0; i<indices.length; i++) {
            let idx = indices[i];
            finalPos.push(positions[idx*3], positions[idx*3+1], positions[idx*3+2]);
            finalNorm.push(normals[idx*3], normals[idx*3+1], normals[idx*3+2]);
        }
        return { positions: new Float32Array(finalPos), normals: new Float32Array(finalNorm), count: finalPos.length/3 };
    }
    
    function createStarMesh() {
        const positions = [], normals = [];
        function addTriangle(p1, p2, p3) {
            const v1 = [p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]];
            const v2 = [p3[0]-p1[0], p3[1]-p1[1], p3[2]-p1[2]];
            const nx = v1[1]*v2[2] - v1[2]*v2[1];
            const ny = v1[2]*v2[0] - v1[0]*v2[2];
            const nz = v1[0]*v2[1] - v1[1]*v2[0];
            const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
            const n = [nx/len, ny/len, nz/len];
            positions.push(...p1, ...p2, ...p3);
            normals.push(...n, ...n, ...n);
        }
        const points = 5;
        const outerRadius = 1.5; const innerRadius = 0.6; const thickness = 0.4; 
        const perimeterPoints = [];
        for (let i = 0; i < points * 2; i++) {
            const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
            const r = (i % 2 === 0) ? outerRadius : innerRadius;
            const x = Math.cos(angle) * r;
            const y = Math.sin(angle) * r; 
            perimeterPoints.push([x, y, 0]); 
        }
        const centerFront = [0, 0, thickness];
        const centerBack = [0, 0, -thickness];
        for (let i = 0; i < perimeterPoints.length; i++) {
            const nextIndex = (i + 1) % perimeterPoints.length;
            const pCurrent = perimeterPoints[i];
            const pNext = perimeterPoints[nextIndex];
            addTriangle(centerFront, [pCurrent[0], pCurrent[1], 0], [pNext[0], pNext[1], 0]);
            addTriangle(centerBack, [pNext[0], pNext[1], 0], [pCurrent[0], pCurrent[1], 0]);
        }
        return { positions: new Float32Array(positions), normals: new Float32Array(normals), count: positions.length/3 };
    }

    function getHeight(x, z) {
        let y = 0;
        y += Math.sin(x * 0.03 + z * 0.04) * 15.0; 
        y += Math.cos(x * 0.1 - z * 0.12) * 6.0;   
        return y; 
    }

    function createTerrain(width, depth, subdivisions) {
        const positions = [];
        const normals = [];
        const scaleX = width / subdivisions;
        const scaleZ = depth / subdivisions;
        for (let z = 0; z <= subdivisions; z++) {
            for (let x = 0; x <= subdivisions; x++) {
                const px = (x - subdivisions / 2) * scaleX;
                const pz = (z - subdivisions / 2) * scaleZ;
                const py = getHeight(px, pz);
                positions.push(px, py, pz);
                normals.push(0, 1, 0); 
            }
        }
        const finalPos = [], finalNorm = [];
        for (let z = 0; z < subdivisions; z++) {
            for (let x = 0; x < subdivisions; x++) {
                const r1 = z * (subdivisions + 1) + x;
                const r2 = (z + 1) * (subdivisions + 1) + x;
                pushVert(r1, positions, normals, finalPos, finalNorm);
                pushVert(r2, positions, normals, finalPos, finalNorm);
                pushVert(r1 + 1, positions, normals, finalPos, finalNorm);
                pushVert(r1 + 1, positions, normals, finalPos, finalNorm);
                pushVert(r2, positions, normals, finalPos, finalNorm);
                pushVert(r2 + 1, positions, normals, finalPos, finalNorm);
            }
        }
        return { positions: new Float32Array(finalPos), normals: new Float32Array(finalNorm), count: finalPos.length/3 };
    }
    function pushVert(idx, sp, sn, dp, dn) {
        dp.push(sp[idx*3], sp[idx*3+1], sp[idx*3+2]);
        dn.push(sn[idx*3], sn[idx*3+1], sn[idx*3+2]);
    }

    function createShapeBuffer(data) {
        const pBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data.positions, gl.STATIC_DRAW);
        const nBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, nBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data.normals, gl.STATIC_DRAW);
        return { pos: pBuffer, norm: nBuffer, count: data.count };
    }
    
    function createSphere(radius, subdivisions) {
        const positions = [], normals = [];
        for (let lat = 0; lat <= subdivisions; lat++) {
            const theta = lat * Math.PI / subdivisions;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);
            for (let lon = 0; lon <= subdivisions; lon++) {
                const phi = lon * 2 * Math.PI / subdivisions;
                const x = Math.cos(phi) * sinTheta;
                const y = cosTheta;
                const z = Math.sin(phi) * sinTheta;
                positions.push(radius * x, radius * y, radius * z);
                normals.push(x, y, z); 
            }
        }
        const indices = [];
        for (let lat = 0; lat < subdivisions; lat++) {
            for (let lon = 0; lon < subdivisions; lon++) {
                const first = (lat * (subdivisions + 1)) + lon;
                const second = first + subdivisions + 1;
                indices.push(first, second, first + 1);
                indices.push(second, second + 1, first + 1);
            }
        }
        const finalPos = [], finalNorm = [];
        for(let i=0; i<indices.length; i++) {
            const idx = indices[i];
            finalPos.push(positions[idx*3], positions[idx*3+1], positions[idx*3+2]);
            finalNorm.push(normals[idx*3], normals[idx*3+1], normals[idx*3+2]);
        }
        return { positions: new Float32Array(finalPos), normals: new Float32Array(finalNorm), count: finalPos.length/3 };
    }

    function createCone(radius, height, segments) {
        const positions = [], normals = [];
        const tip = [0, height, 0];
        const center = [0, 0, 0];
        for (let i = 0; i < segments; i++) {
            const angle = i * 2 * Math.PI / segments;
            const nextAngle = (i + 1) * 2 * Math.PI / segments;
            const x1 = Math.cos(angle) * radius; const z1 = Math.sin(angle) * radius;
            const x2 = Math.cos(nextAngle) * radius; const z2 = Math.sin(nextAngle) * radius;
            const nx1 = x1/radius, nz1 = z1/radius; const nx2 = x2/radius, nz2 = z2/radius;
            positions.push(tip[0], tip[1], tip[2]); normals.push(nx1, 0.5, nz1); 
            positions.push(x1, 0, z1);              normals.push(nx1, 0, nz1);
            positions.push(x2, 0, z2);              normals.push(nx2, 0, nz2);
            positions.push(center[0], center[1], center[2]); normals.push(0, -1, 0);
            positions.push(x2, 0, z2);                       normals.push(0, -1, 0);
            positions.push(x1, 0, z1);                       normals.push(0, -1, 0);
        }
        return { positions: new Float32Array(positions), normals: new Float32Array(normals), count: positions.length/3 };
    }

    function createCylinder(radius, height, segments) {
        const positions = [], normals = [];
        const halfH = height / 2;
        for (let i = 0; i < segments; i++) {
            const theta = i * 2 * Math.PI / segments;
            const nextTheta = (i + 1) * 2 * Math.PI / segments;
            const x1 = Math.cos(theta) * radius; const z1 = Math.sin(theta) * radius;
            const x2 = Math.cos(nextTheta) * radius; const z2 = Math.sin(nextTheta) * radius;
            const nx1 = x1/radius, nz1 = z1/radius; const nx2 = x2/radius, nz2 = z2/radius;
            positions.push(x1, halfH, z1);  normals.push(nx1, 0, nz1);
            positions.push(x1, -halfH, z1); normals.push(nx1, 0, nz1);
            positions.push(x2, -halfH, z2); normals.push(nx2, 0, nz2);
            positions.push(x1, halfH, z1);  normals.push(nx1, 0, nz1);
            positions.push(x2, -halfH, z2); normals.push(nx2, 0, nz2);
            positions.push(x2, halfH, z2);  normals.push(nx2, 0, nz2);
            positions.push(0, halfH, 0); normals.push(0, 1, 0);
            positions.push(x2, halfH, z2); normals.push(0, 1, 0);
            positions.push(x1, halfH, z1); normals.push(0, 1, 0);
            positions.push(0, -halfH, 0); normals.push(0, -1, 0);
            positions.push(x1, -halfH, z1); normals.push(0, -1, 0);
            positions.push(x2, -halfH, z2); normals.push(0, -1, 0);
        }
        return { positions: new Float32Array(positions), normals: new Float32Array(normals), count: positions.length/3 };
    }

    function createCube() {
        const p = [
            -0.5,-0.5,0.5, 0.5,-0.5,0.5, -0.5,0.5,0.5, -0.5,0.5,0.5, 0.5,-0.5,0.5, 0.5,0.5,0.5,
            -0.5,-0.5,-0.5, -0.5,0.5,-0.5, 0.5,-0.5,-0.5, -0.5,0.5,-0.5, 0.5,0.5,-0.5, 0.5,-0.5,-0.5,
            -0.5,0.5,-0.5, -0.5,0.5,0.5, 0.5,0.5,-0.5, -0.5,0.5,0.5, 0.5,0.5,0.5, 0.5,0.5,-0.5,
            -0.5,-0.5,-0.5, 0.5,-0.5,-0.5, -0.5,-0.5,0.5, -0.5,-0.5,0.5, 0.5,-0.5,-0.5, 0.5,-0.5,0.5,
            -0.5,-0.5,-0.5, -0.5,-0.5,0.5, -0.5,0.5,-0.5, -0.5,-0.5,0.5, -0.5,0.5,0.5, -0.5,0.5,-0.5,
            0.5,-0.5,-0.5, 0.5,0.5,-0.5, 0.5,-0.5,0.5, 0.5,-0.5,0.5, 0.5,0.5,-0.5, 0.5,0.5,0.5,
        ];
        const n = [
            0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1,
            0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
            0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0,
            0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
            -1,0,0, -1,0,0, -1,0,0, -1,0,0, -1,0,0, -1,0,0,
            1,0,0, 1,0,0, 1,0,0, 1,0,0, 1,0,0, 1,0,0,
        ];
        return { positions: new Float32Array(p), normals: new Float32Array(n), count: 36 };
    }

    const shapes = {
        cube: createShapeBuffer(createCube()),
        sphere: createShapeBuffer(createSphere(0.5, 16)),
        cone: createShapeBuffer(createCone(0.5, 1.0, 16)),
        cylinder: createShapeBuffer(createCylinder(0.5, 1.0, 16)),
        terrain: createShapeBuffer(createTerrain(400, 150, 64)),
        hill: createShapeBuffer(createIrregularHill(6, 5, 6)),
        star: createShapeBuffer(createStarMesh())
    };

    function drawShape(shapeName, viewProjection, worldMatrix, color, emissive = 0, isTerrain = 0) {
        const shape = shapes[shapeName];
        const finalMatrix = m4.multiply(viewProjection, worldMatrix);
        gl.uniformMatrix4fv(matrixLoc, false, finalMatrix);
        gl.uniformMatrix4fv(worldLoc, false, worldMatrix);
        gl.uniform4fv(colorLoc, color);
        gl.uniform1f(emissiveLoc, emissive);
        gl.uniform1f(isTerrainLoc, isTerrain); 
        
        gl.bindBuffer(gl.ARRAY_BUFFER, shape.pos);
        gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(posLoc);
        gl.bindBuffer(gl.ARRAY_BUFFER, shape.norm);
        gl.vertexAttribPointer(normLoc, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(normLoc);
        gl.drawArrays(gl.TRIANGLES, 0, shape.count);
    }

    function drawCube(viewProjection, worldMatrix, color, emissive=0) {
        drawShape('cube', viewProjection, worldMatrix, color, emissive);
    }

    // Funções de Desenho Auxiliares
    
    function drawPolarBear(vp, m, run) {
        let torso = m4.translate(m, 0, 1.2, 0);
        let torsoScale = m4.scale(torso, 1.8, 1.5, 2.5);
        drawCube(vp, torsoScale, Colors.BEAR_FUR);
        
        let head = m4.translate(torso, 0, 0.8, 1.2);
        let headScale = m4.scale(head, 1.0, 1.0, 1.2);
        drawCube(vp, headScale, Colors.BEAR_FUR);
        
        let nose = m4.translate(head, 0, -0.2, 0.6);
        drawCube(vp, m4.scale(nose, 0.6, 0.5, 0.4), Colors.BEAR_FUR);
        drawCube(vp, m4.scale(m4.translate(nose, 0, 0.2, 0.25), 0.2, 0.2, 0.1), Colors.BEAR_NOSE);
        
        drawCube(vp, m4.scale(m4.translate(head, 0.4, 0.6, 0), 0.2, 0.2, 0.1), Colors.BEAR_FUR);
        drawCube(vp, m4.scale(m4.translate(head, -0.4, 0.6, 0), 0.2, 0.2, 0.1), Colors.BEAR_FUR);
        
        let legW = 0.5; let legH = 1.2; let legY = -0.8;
        let fl = m4.translate(torso, 0.5, legY, 0.8); fl = m4.xRotate(fl, run); drawCube(vp, m4.scale(fl, legW, legH, legW), Colors.BEAR_FUR);
        let fr = m4.translate(torso, -0.5, legY, 0.8); fr = m4.xRotate(fr, -run); drawCube(vp, m4.scale(fr, legW, legH, legW), Colors.BEAR_FUR);
        let bl = m4.translate(torso, 0.5, legY, -0.8); bl = m4.xRotate(bl, -run); drawCube(vp, m4.scale(bl, legW, legH, legW), Colors.BEAR_FUR);
        let br = m4.translate(torso, -0.5, legY, -0.8); br = m4.xRotate(br, run); drawCube(vp, m4.scale(br, legW, legH, legW), Colors.BEAR_FUR);
    }
    
    function drawGift(vp, m) { 
        drawShape('cube', vp, m4.scale(m, 1.0, 1.0, 1.0), Colors.GIFT_R); 
        drawShape('cube', vp, m4.scale(m, 1.1, 0.2, 1.1), Colors.GOLD); 
        drawShape('cube', vp, m4.scale(m, 0.2, 1.1, 1.1), Colors.GOLD); 
    }

    function drawSnowman(vp, m, s) { 
        drawShape('sphere', vp, m4.scale(m4.translate(m, 0, 1.0*s, 0), 2.0*s, 2.0*s, 2.0*s), Colors.SNOW); 
        drawShape('sphere', vp, m4.scale(m4.translate(m, 0, 1.2*s, 0.95*s), 0.15*s, 0.15*s, 0.15*s), Colors.BLACK); 
        drawShape('sphere', vp, m4.scale(m4.translate(m, 0, 2.6*s, 0), 1.5*s, 1.5*s, 1.5*s), Colors.SNOW); 
        drawShape('sphere', vp, m4.scale(m4.translate(m, 0, 2.6*s, 0.7*s), 0.15*s, 0.15*s, 0.15*s), Colors.BLACK); 
        drawShape('sphere', vp, m4.scale(m4.translate(m, 0, 3.0*s, 0.6*s), 0.15*s, 0.15*s, 0.15*s), Colors.BLACK); 
        let head = m4.translate(m, 0, 3.8*s, 0); 
        drawShape('sphere', vp, m4.scale(head, 1.0*s, 1.0*s, 1.0*s), Colors.SNOW); 
        drawShape('sphere', vp, m4.scale(m4.translate(head, 0.2*s, 0.1*s, 0.45*s), 0.1*s, 0.1*s, 0.1*s), Colors.BLACK); 
        drawShape('sphere', vp, m4.scale(m4.translate(head, -0.2*s, 0.1*s, 0.45*s), 0.1*s, 0.1*s, 0.1*s), Colors.BLACK); 
        let nose = m4.translate(head, 0, 0, 0.4*s); nose = m4.xRotate(nose, Math.PI/2); 
        drawShape('cone', vp, m4.scale(nose, 0.15*s, 0.8*s, 0.15*s), Colors.CARROT); 
        drawShape('cylinder', vp, m4.scale(m4.translate(head, 0, 0.45*s, 0), 1.2*s, 0.1*s, 1.2*s), Colors.BLACK); 
        drawShape('cylinder', vp, m4.scale(m4.translate(head, 0, 0.8*s, 0), 0.7*s, 0.8*s, 0.7*s), Colors.BLACK); 
    }

    function drawTree(vp, m, s) { 
        drawShape('cube', vp, m4.scale(m4.translate(m, 0, 1.0*s, 0), 0.6*s, 2.0*s, 0.6*s), Colors.WOOD); 
        drawShape('cone', vp, m4.scale(m4.translate(m, 0, 2.0*s, 0), 2.5*s, 2.5*s, 2.5*s), Colors.LEAF); 
        drawShape('cone', vp, m4.scale(m4.translate(m, 0, 3.5*s, 0), 2.0*s, 2.0*s, 2.0*s), Colors.LEAF); 
        drawShape('cone', vp, m4.scale(m4.translate(m, 0, 4.8*s, 0), 1.5*s, 1.5*s, 1.5*s), Colors.LEAF); 
    }

    function drawRock(vp, m, s) { 
        drawShape('cube', vp, m4.scale(m4.translate(m, 0, 0.5*s, 0), 2.0*s, 1.0*s, 1.5*s), [0.5, 0.5, 0.5, 1]); 
    }

    function drawSled(vp, m) { 
        drawShape('cylinder', vp, m4.scale(m4.multiply(m4.translate(m, 1.2, -0.5, 0), m4.xRotate(m4.identity(), Math.PI/2)), 0.2, 4.0, 0.2), Colors.GOLD); 
        drawShape('cylinder', vp, m4.scale(m4.multiply(m4.translate(m, -1.2, -0.5, 0), m4.xRotate(m4.identity(), Math.PI/2)), 0.2, 4.0, 0.2), Colors.GOLD); 
        drawShape('cube', vp, m4.scale(m4.translate(m, 0, 0, 0), 2.5, 0.2, 3), Colors.RED); 
        drawShape('cube', vp, m4.scale(m4.translate(m, 1.1, 0.5, 0), 0.2, 1.0, 3), Colors.RED); 
        drawShape('cube', vp, m4.scale(m4.translate(m, -1.1, 0.5, 0), 0.2, 1.0, 3), Colors.RED); 
        let front = m4.translate(m, 0, 0.5, -1.5); front = m4.xRotate(front, -0.5); 
        drawShape('cube', vp, m4.scale(front, 2.4, 0.8, 0.2), Colors.RED); 
        let back = m4.translate(m, 0, 0.8, 1.5); 
        drawShape('cube', vp, m4.scale(back, 2.4, 1.5, 0.2), Colors.RED); 
        drawShape('cube', vp, m4.scale(m4.translate(m, 0, 0.4, 0.5), 2.2, 0.4, 1.0), Colors.SEAT); 
        drawShape('cube', vp, m4.scale(m4.translate(m, 0, 1.0, 1.0), 1.5, 1.5, 1.0), Colors.GOLD); 
    }

    function drawSantaDetailed(vp, m, walkCycle) { 
        let torsoMatrix = m4.translate(m, 0, 2 + Math.abs(walkCycle)*0.2, 0); 
        torsoMatrix = m4.yRotate(torsoMatrix, Math.sin(gameState.time)*0.1); 
        let torsoDrawMatrix = m4.scale(torsoMatrix, 1.5, 2, 1); 
        drawCube(vp, torsoDrawMatrix, Colors.SANTA_RED); 
        let beltMatrix = m4.translate(torsoMatrix, 0, -0.2, 0); 
        let beltDrawMatrix = m4.scale(beltMatrix, 1.6, 0.4, 1.1); 
        drawCube(vp, beltDrawMatrix, Colors.SANTA_BELT); 
        let buckleMatrix = m4.translate(torsoMatrix, 0, -0.2, 0.6); 
        let buckleDrawMatrix = m4.scale(buckleMatrix, 0.5, 0.5, 0.1); 
        drawCube(vp, buckleDrawMatrix, Colors.SANTA_GOLD); 
        let coatDetailMatrix = m4.translate(torsoMatrix, 0, 0.2, 0.55); 
        let coatDetailDrawMatrix = m4.scale(coatDetailMatrix, 0.3, 1.6, 0.1); 
        drawCube(vp, coatDetailDrawMatrix, Colors.SANTA_WHITE); 
        let headMatrix = m4.translate(torsoMatrix, 0, 1.5, 0); 
        let headDrawMatrix = m4.scale(headMatrix, 1, 1, 1); 
        drawCube(vp, headDrawMatrix, Colors.SANTA_SKIN); 
        let beardMatrix = m4.translate(headMatrix, 0, -0.3, 0.4); 
        let beardDrawMatrix = m4.scale(beardMatrix, 0.8, 0.6, 0.4); 
        drawCube(vp, beardDrawMatrix, Colors.SANTA_WHITE); 
        let hatMatrix = m4.translate(headMatrix, 0, 0.6, 0); 
        let hatDrawMatrix = m4.scale(hatMatrix, 1.1, 0.6, 1.1); 
        drawCube(vp, hatDrawMatrix, Colors.SANTA_RED); 
        let pompomMatrix = m4.translate(hatMatrix, 0.6, 0.3, 0); 
        let pompomDrawMatrix = m4.scale(pompomMatrix, 0.3, 0.3, 0.3); 
        drawCube(vp, pompomDrawMatrix, Colors.SANTA_WHITE); 
        let lArmMatrix = m4.translate(torsoMatrix, 1, 0.8, 0); lArmMatrix = m4.xRotate(lArmMatrix, -walkCycle); 
        let lArmDrawMatrix = m4.translate(lArmMatrix, 0, -0.6, 0); lArmDrawMatrix = m4.scale(lArmDrawMatrix, 0.4, 1.2, 0.4); 
        drawCube(vp, lArmDrawMatrix, Colors.SANTA_RED); 
        let rArmMatrix = m4.translate(torsoMatrix, -1, 0.8, 0); rArmMatrix = m4.xRotate(rArmMatrix, walkCycle); 
        let rArmDrawMatrix = m4.translate(rArmMatrix, 0, -0.6, 0); rArmDrawMatrix = m4.scale(rArmDrawMatrix, 0.4, 1.2, 0.4); 
        drawCube(vp, rArmDrawMatrix, Colors.SANTA_RED); 
        let lLegMatrix = m4.translate(torsoMatrix, 0.5, -1, 0); lLegMatrix = m4.xRotate(lLegMatrix, walkCycle); 
        let lLegDrawMatrix = m4.translate(lLegMatrix, 0, -0.8, 0); lLegDrawMatrix = m4.scale(lLegDrawMatrix, 0.5, 1.5, 0.5); 
        drawCube(vp, lLegDrawMatrix, Colors.SANTA_BOOT); 
        let rLegMatrix = m4.translate(torsoMatrix, -0.5, -1, 0); rLegMatrix = m4.xRotate(rLegMatrix, -walkCycle); 
        let rLegDrawMatrix = m4.translate(rLegMatrix, 0, -0.8, 0); rLegDrawMatrix = m4.scale(rLegDrawMatrix, 0.5, 1.5, 0.5); 
        drawCube(vp, rLegDrawMatrix, Colors.SANTA_BOOT); 
    }

    function drawSantaSimple(vp, m) { 
        let torso = m4.translate(m, 0, 0.8, 0); 
        drawShape('cube', vp, m4.scale(torso, 1.2, 1.4, 0.8), Colors.RED); 
        drawShape('cube', vp, m4.scale(m4.translate(m, 0, 0.6, 0.1), 1.25, 0.3, 0.85), Colors.BLACK); 
        drawShape('cube', vp, m4.scale(m4.translate(m, 0, 0.6, 0.55), 0.3, 0.3, 0.1), Colors.GOLD); 
        let head = m4.translate(m, 0, 1.8, 0); 
        drawShape('cube', vp, m4.scale(head, 0.7, 0.7, 0.7), Colors.SKIN); 
        drawShape('cube', vp, m4.scale(m4.translate(head, 0, -0.2, 0.3), 0.7, 0.6, 0.3), Colors.WHITE); 
        let hat = m4.translate(head, 0, 0.4, 0); 
        drawShape('cube', vp, m4.scale(hat, 0.8, 0.5, 0.8), Colors.RED); 
        drawShape('cube', vp, m4.scale(m4.translate(hat, 0.4, 0.3, 0), 0.2, 0.2, 0.2), Colors.WHITE); 
        drawShape('cube', vp, m4.scale(m4.translate(torso, 0.7, 0.2, 0.2), 0.3, 0.8, 0.3), Colors.RED); 
        drawShape('cube', vp, m4.scale(m4.translate(torso, -0.7, 0.2, 0.2), 0.3, 0.8, 0.3), Colors.RED); 
    }

    function drawReindeer(vp, m, time) { 
        let run = Math.sin(time * 15); 
        let torso = m4.translate(m, 0, 1.0, 0); 
        drawShape('cube', vp, m4.scale(torso, 0.8, 0.8, 1.8), Colors.FUR_L); 
        let neck = m4.translate(torso, 0, 0.6, -0.8); neck = m4.xRotate(neck, -0.5); 
        drawShape('cube', vp, m4.scale(neck, 0.5, 1.0, 0.5), Colors.FUR_L); 
        let head = m4.translate(neck, 0, 0.6, -0.2); 
        drawShape('cube', vp, m4.scale(head, 0.6, 0.5, 0.8), Colors.FUR_L); 
        drawShape('cube', vp, m4.scale(m4.translate(head, 0, 0, -0.45), 0.2, 0.2, 0.2), Colors.NOSE_R, 1.0); 
        drawShape('cube', vp, m4.scale(m4.translate(head, 0.3, 0.5, 0), 0.1, 0.6, 0.1), Colors.ANTLER); 
        drawShape('cube', vp, m4.scale(m4.translate(head, -0.3, 0.5, 0), 0.1, 0.6, 0.1), Colors.ANTLER); 
        
        let legSize = [0.25, 1.0, 0.25]; let legY = -0.6; 
        let fl = m4.translate(torso, 0.3, legY, -0.7); fl = m4.xRotate(fl, run); drawShape('cube', vp, m4.scale(m4.translate(fl,0,-0.4,0), ...legSize), Colors.FUR_D); 
        let fr = m4.translate(torso, -0.3, legY, -0.7); fr = m4.xRotate(fr, -run); drawShape('cube', vp, m4.scale(m4.translate(fr,0,-0.4,0), ...legSize), Colors.FUR_D); 
        let bl = m4.translate(torso, 0.3, legY, 0.7); bl = m4.xRotate(bl, -run); drawShape('cube', vp, m4.scale(m4.translate(bl,0,-0.4,0), ...legSize), Colors.FUR_D); 
        let br = m4.translate(torso, -0.3, legY, -0.7); br = m4.xRotate(br, run); drawShape('cube', vp, m4.scale(m4.translate(br,0,-0.4,0), ...legSize), Colors.FUR_D); 
    }

    let lastTime = 0;

    function render(now) {
        if (gameState.gameOver) return; 

        now *= 0.001;
        const deltaTime = now - lastTime;
        lastTime = now;
        gameState.time = now;

        // Movimento
        if (keys['a'] || keys['arrowleft']) gameState.playerX -= 25 * deltaTime;
        if (keys['d'] || keys['arrowright']) gameState.playerX += 25 * deltaTime;
        gameState.playerX = Math.max(-10, Math.min(10, gameState.playerX));

        // Pulo
        if (keys[' '] && !gameState.isJumping) {
            gameState.yVelocity = 12;
            gameState.isJumping = true;
        }
        if (gameState.isJumping) {
            gameState.playerY += gameState.yVelocity * deltaTime;
            gameState.yVelocity -= 30 * deltaTime;
            if (gameState.playerY <= 0) {
                gameState.playerY = 0;
                gameState.isJumping = false;
            }
        }

        // --- LÓGICA DE VELOCIDADE (RECUPERAÇÃO) ---
        if (gameState.speed < gameState.baseSpeed && !gameState.hasSled) {
            gameState.speed += 2.0 * deltaTime; 
            if (gameState.speed > gameState.baseSpeed) gameState.speed = gameState.baseSpeed;
        } else if (gameState.speed > gameState.baseSpeed) {
            gameState.speed -= 2.0 * deltaTime;
        }

        if (gameState.isBeingChased) {
            gameState.bearChaseTimer += deltaTime;

            let relativeSpeed = gameState.speed - gameState.baseSpeed; // Se negativo, urso ganha terreno.
            
            if (relativeSpeed < 0) {
                gameState.bearProximity += Math.abs(relativeSpeed) * 1.5 * deltaTime; 
            } else {
                // Se velocidade normal ou alta, ursso não ganha terrenonv talvez perca um pouco.
                gameState.bearProximity -= 2.0 * deltaTime; 
                if (gameState.bearProximity < 0) gameState.bearProximity = 0;
            }

            // Checa captura
            if (gameState.bearProximity >= 100) {
                gameState.gameOver = true;
                gameState.gameOverReason = "O Urso te pegou porque você estava muito lento!";
                document.getElementById('gameOverReason').innerText = gameState.gameOverReason;
                document.getElementById('gameOverScreen').style.display = 'flex';
                document.getElementById('finalScore').innerText = Math.floor(gameState.score);
                return;
            }

            // Checa desistencia do urso
            if (gameState.bearChaseTimer > 10.0 && gameState.bearProximity < 80) {
                gameState.isBeingChased = false;
                gameState.bearProximity = 0;
                gameState.bearChaseTimer = 0;
            }
        } else {
            gameState.bearProximity = 0;
        }

        // Tiro
        if (keys['f'] && gameState.hasSled && gameState.canShoot) {
            if (now - gameState.lastShotTime > 0.3) { 
                bullets.push({
                    x: gameState.playerX,
                    y: gameState.playerY + 1.5,
                    z: -3.0,
                    active: true
                });
                gameState.lastShotTime = now;
            }
        }

        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
            gl.viewport(0, 0, canvas.width, canvas.height);
        }

        // Hit effect (vermelho se bateu)
        gl.clearColor(gameState.hit ? 0.3 : 0.05, 0.05, gameState.hit ? 0.1 : 0.2, 1.0);
        gameState.hit = false;
        
        gl.enable(gl.DEPTH_TEST);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(program);

        // UI
        let statusText = "A PÉ";
        if(gameState.isBeingChased) statusText += " [CORRE! URSO ATRÁS!]";
        if(gameState.hasSled) {
            statusText = "TRENÓ (PODER: " + (gameState.canShoot ? "GELO" : "NENHUM") + ")";
            if (gameState.speed > 30) statusText += " [TURBO]";
        }
        document.getElementById('status').innerText = statusText;
        if(gameState.isBeingChased) document.getElementById('status').style.color = "#ff5555";
        else if(gameState.hasSled) document.getElementById('status').style.color = "#00ffff";
        else document.getElementById('status').style.color = "#aaa";

        // Luzes
        const moonDir = m4.normalize([0.2, 0.5, 1.0]); 
        gl.uniform3fv(lightLoc, moonDir); 

        const noseX = gameState.playerX;
        const noseY = gameState.playerY + (gameState.hasSled ? 1.5 : 1.0);
        const noseZ = -5.0;
        gl.uniform3fv(noseLightPosLoc, [noseX, noseY, noseZ]);
        
        if (gameState.hasSled) {
            gl.uniform3fv(noseLightColorLoc, [1.0, 0.8, 0.1]); 
        } else {
            gl.uniform3fv(noseLightColorLoc, [0.0, 0.0, 0.0]); 
        }

        // --- LUZES DOS ITENS ESPECIAIS --- (obs -- rever dps (o da lua não ta bom))
        let visibleSpecialItems = [];
        scenery.forEach(obj => {
            if (obj.active && obj.isSpecial && obj.z > -60 && obj.z < 20) {
                let dist = Math.abs(obj.z - 0); 
                visibleSpecialItems.push({ obj: obj, dist: dist });
            }
        });
        visibleSpecialItems.sort((a, b) => a.dist - b.dist);

        if (visibleSpecialItems.length > 0) {
            let item = visibleSpecialItems[0].obj;
            gl.uniform3fv(itemLightPos1Loc, [item.x, 1.5, item.z]);
            if (item.type === 'shoot_powerup') gl.uniform3fv(itemLightColor1Loc, Colors.ICE);
            else gl.uniform3fv(itemLightColor1Loc, Colors.GOLD);
        } else {
            gl.uniform3fv(itemLightPos1Loc, [0, -100, 0]); 
            gl.uniform3fv(itemLightColor1Loc, [0, 0, 0]);
        }

        if (visibleSpecialItems.length > 1) {
            let item = visibleSpecialItems[1].obj;
            gl.uniform3fv(itemLightPos2Loc, [item.x, 1.5, item.z]);
            if (item.type === 'shoot_powerup') gl.uniform3fv(itemLightColor2Loc, Colors.ICE);
            else gl.uniform3fv(itemLightColor2Loc, Colors.GOLD);
        } else {
            gl.uniform3fv(itemLightPos2Loc, [0, -100, 0]); 
            gl.uniform3fv(itemLightColor2Loc, [0, 0, 0]);
        }

        const aspect = canvas.clientWidth / canvas.clientHeight;
        const projection = m4.perspective(60 * Math.PI / 180, aspect, 0.1, 400);
        
        let camHeight = gameState.hasSled ? 8 : 6;
        let camDist = gameState.hasSled ? 16 : 14; 
        const cameraPos = [0, camHeight, camDist]; 
        const target = [0, 3, -10];
        const viewMatrix = m4.inverse(m4.lookAt(cameraPos, target, [0, 1, 0]));
        const viewProjection = m4.multiply(projection, viewMatrix);
        gl.uniform3fv(viewPosLoc, cameraPos);

        // --- BACKGROUND ---
        let moonM = m4.translation(20, 30, -100); 
        drawShape('sphere', viewProjection, m4.scale(moonM, 8, 8, 8), Colors.MOON, 1.0); 

        stars.forEach(star => {
            let starM = m4.translation(star.x, star.y, star.z);
            let twinkle = 0.8 + Math.sin(now * 5 + star.x) * 0.2; 
            drawCube(viewProjection, m4.scale(starM, star.size, star.size, star.size), Colors.STAR, twinkle);
        });

        // --- MONTANHAS DE FUNDO ---
        let terrainM = m4.translation(0, -10, -250); 
        drawShape('terrain', viewProjection, terrainM, Colors.MOUNTAIN_ROCK, 0, 2.0); 

        //  CHÃO 
        let floorM = m4.translation(0, -1, -50);
        floorM = m4.scale(floorM, 24, 1, 400); 
        drawCube(viewProjection, floorM, Colors.SNOW);

        let leftSideM = m4.translation(-62, -1, -50); 
        leftSideM = m4.scale(leftSideM, 100, 1, 400);
        drawCube(viewProjection, leftSideM, Colors.DEEP_SNOW);

        let rightSideM = m4.translation(62, -1, -50); 
        rightSideM = m4.scale(rightSideM, 100, 1, 400);
        drawCube(viewProjection, rightSideM, Colors.DEEP_SNOW);

        // --- JOGADOR + URSO ---
        if (gameState.isBeingChased) {
            let bearZ = 8.0 - (gameState.bearProximity / 100.0) * 8.0; 
            let bearOffsetX = gameState.playerX > 0 ? -3 : 3; 
            let bearM = m4.translation(gameState.playerX + bearOffsetX, 0, bearZ);
            bearM = m4.yRotate(bearM, Math.PI); 
            bearM = m4.yRotate(bearM, gameState.playerX > 0 ? -0.3 : 0.3);
            let run = Math.sin(now * 20);
            drawPolarBear(viewProjection, bearM, run);
        }

        let playerGroup = m4.translation(gameState.playerX, gameState.playerY, 0);
        if(gameState.isJumping) playerGroup = m4.xRotate(playerGroup, -0.2);

        if (gameState.hasSled) {
            drawSled(viewProjection, playerGroup);
            let seatedSantaM = m4.translate(playerGroup, 0, 0.5, 0.5);
            seatedSantaM = m4.yRotate(seatedSantaM, Math.PI); 
            drawSantaSimple(viewProjection, seatedSantaM);
            drawReindeer(viewProjection, m4.translate(playerGroup, 0, 0, -4.5), now);
            
            let reinL = m4.translate(playerGroup, 0.5, 1, -2);
            drawShape('cylinder', viewProjection, m4.scale(m4.multiply(reinL, m4.xRotate(m4.identity(), Math.PI/2)), 0.05, 4.0, 0.05), Colors.GOLD);
            let reinR = m4.translate(playerGroup, -0.5, 1, -2);
            drawShape('cylinder', viewProjection, m4.scale(m4.multiply(reinR, m4.xRotate(m4.identity(), Math.PI/2)), 0.05, 4.0, 0.05), Colors.GOLD);
        } else {
            let walkCycle = Math.sin(now * 15); 
            let santaM = m4.translate(playerGroup, 0, 0, 0); 
            santaM = m4.yRotate(santaM, Math.PI); 
            santaM = m4.zRotate(santaM, Math.sin(now * 10) * 0.05);
            santaM = m4.scale(santaM, 0.5, 0.5, 0.5); 
            drawSantaDetailed(viewProjection, santaM, walkCycle);
        }

        // bolinhas de gelo
        bullets.forEach((b, i) => {
            if(!b.active) return;
            b.z -= 60 * deltaTime; 
            
            let bM = m4.translation(b.x, b.y, b.z);
            drawShape('sphere', viewProjection, m4.scale(bM, 0.3, 0.3, 0.3), Colors.ICE, 1.0);

            if (b.z < -200) b.active = false;
        });

        // --- OBJETOS DO CENÁRIO ---
        scenery.forEach(obj => {
            if (!obj.active) return;

            obj.z += gameState.speed * deltaTime;
            obj.rot += deltaTime; 

            if (obj.type === 'walking_bear') {
                obj.x += obj.dx * deltaTime;
                if (obj.x > 15 || obj.x < -15) obj.dx *= -1; 
            }

            if(obj.z > 15) {
                const newObj = spawnObject(-250 - Math.random() * 50);
                obj.x = newObj.x;
                obj.z = newObj.z;
                obj.type = newObj.type;
                obj.scale = newObj.scale;
                obj.active = true;
                obj.rot = 0;
                obj.dx = newObj.dx; 
                obj.isSpecial = newObj.isSpecial; 
            }

            let objM = m4.translation(obj.x, 0, obj.z);

            if (obj.type === 'gift') {
                objM = m4.yRotate(objM, now * 2);
                objM = m4.translate(objM, 0, 0.5 + Math.sin(now*3)*0.2, 0); 
                drawGift(viewProjection, objM);
                checkPickups(obj);
            } 
            else if (obj.type === 'sled_pickup') {
                objM = m4.yRotate(objM, obj.rot);
                objM = m4.translate(objM, 0, 1.0, 0);
                drawSled(viewProjection, m4.scale(objM, 0.8, 0.8, 0.8)); 
                checkPickups(obj);
            }
            else if (obj.type === 'star_powerup') {
                objM = m4.yRotate(objM, obj.rot * 2); 
                let pulse = 1.0 + Math.sin(now * 5.0) * 0.2; 
                objM = m4.scale(objM, pulse, pulse, pulse);
                objM = m4.translate(objM, 0, 1.5, 0);
                drawShape('star', viewProjection, objM, Colors.STAR, 1.0); 
                checkPickups(obj);
            }
            else if (obj.type === 'shoot_powerup') {
                objM = m4.translate(objM, 0, 1.5 + Math.sin(now*4)*0.3, 0);
                drawShape('sphere', viewProjection, m4.scale(objM, 0.8, 0.8, 0.8), Colors.ICE, 1.0);
                checkPickups(obj);
            }
            else if (obj.type === 'villain') {
                drawSnowman(viewProjection, objM, obj.scale);
                checkCollisionsAndCombat(obj);
            } 
            else if (obj.type === 'tree') {
                drawTree(viewProjection, objM, obj.scale);
            } 
            else if (obj.type === 'rock') {
                drawRock(viewProjection, objM, obj.scale);
                checkCollisionsAndCombat(obj);
            }
            else if (obj.type === 'hill') {
                drawShape('hill', viewProjection, objM, Colors.MOUNTAIN_ROCK, 0, 2.0);
                checkCollisionsAndCombat(obj);
            }
            else if (obj.type === 'walking_bear') {
                let bearM = m4.translate(objM, 0, 0, 0);
                let angle = obj.dx > 0 ? Math.PI/2 : -Math.PI/2;
                bearM = m4.yRotate(bearM, angle);
                let run = Math.sin(now * 15);
                drawPolarBear(viewProjection, bearM, run);
                checkCollisionsAndCombat(obj);
            }
        });

        document.getElementById('scoreVal').innerText = Math.floor(gameState.score);
        requestAnimationFrame(render);
    }
    
    function checkPickups(obj) {
        if (obj.z > -4 && obj.z < 2 && Math.abs(obj.x - gameState.playerX) < 2.0 && obj.active) {
            if (obj.type === 'gift') { 
                gameState.score += 1; // 1 Ponto por presente
                obj.active = false; 
            } 
            else if (obj.type === 'sled_pickup') { if (!gameState.hasSled) { gameState.hasSled = true; gameState.canShoot = false; gameState.speed = 30; obj.active = false; } }
            else if (obj.type === 'star_powerup' && gameState.hasSled) { gameState.speed = 50.0; gameState.score += 2; obj.active = false; }
            else if (obj.type === 'shoot_powerup' && gameState.hasSled) { gameState.canShoot = true; gameState.score += 2; obj.active = false; }
        }
    }

    function checkCollisionsAndCombat(obj) {
        if (obj.type === 'villain') {
            bullets.forEach(b => {
                if (b.active && obj.active) {
                    let dx = b.x - obj.x; let dz = b.z - obj.z;
                    if (Math.sqrt(dx*dx + dz*dz) < 2.0) { obj.active = false; b.active = false; gameState.score += 1; }
                }
            });
        }
        if (obj.active && obj.z > -4 && obj.z < 2) {
            if (Math.abs(obj.x - gameState.playerX) < 2.0) {
                if (gameState.playerY < 1.0) { 
                    // COLISÃO COM PEDRA OU COLINA
                    if (obj.type === 'rock' || obj.type === 'hill') { 
                        gameState.hit = true; 
                        gameState.score = Math.max(0, gameState.score - 1); // Perde 1 ponto
                        // Reduz velocidade drasticamente
                        gameState.speed = 10.0; 
                        obj.active = false;
                    }
                    // COLISÃO COM BONECO DE NEVE (VILÃO)
                    else if (obj.type === 'villain') {
                        if (gameState.hasSled) { 
                            // Se tiver de trenó apenas perde o trenó e desacelera
                            gameState.hasSled = false; 
                            gameState.canShoot = false; 
                            gameState.speed = 10.0; 
                            obj.active = false; 
                            gameState.hit = true; 
                        } 
                        else { 
                            // GAME OVER INSTANTaNEO (X)
                            gameState.gameOver = true;
                            gameState.gameOverReason = "Você bateu no Boneco de Neve Malvado!";
                            document.getElementById('gameOverReason').innerText = gameState.gameOverReason;
                            document.getElementById('gameOverScreen').style.display = 'flex';
                            document.getElementById('finalScore').innerText = Math.floor(gameState.score);
                        }
                    }
                    // COLISÃO COM URSO CAMINHANTE
                    else if (obj.type === 'walking_bear') {
                        // Se colidir o urso começa a perseguir
                        if (!gameState.isBeingChased) { 
                            gameState.isBeingChased = true; 
                            gameState.bearProximity = 20; // Começa ja perto
                            gameState.bearChaseTimer = 0;
                            gameState.hit = true; 
                            obj.active = false; // O urso do cenArio some e vira o perseguidor
                        } 
                        else { 
                            // Se já estava sendo perseguido e bate em OUTRO urso, perde
                            gameState.bearProximity += 50; 
                            gameState.hit = true; 
                            obj.active = false; 
                        }
                    }
                }
            }
        }
    }
    
    // Inicia o loop de animação
    requestAnimationFrame(render);
}