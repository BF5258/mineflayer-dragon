
import { createBot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pkg;
import minecrafthawkeye from 'minecrafthawkeye';
import minecraftData from 'minecraft-data';
const mcData = minecraftData('1.21.8');
import { Vec3 } from "vec3";

/**
 * @typedef {require('prismarine-entity').Entity} Entity
 */

const bot = createBot({
    version: '1.21.8',
    host: 'localhost',
    port: 25565,
    username: 'Archer',
    auth: 'offline'
})

bot.loadPlugin(pathfinder);
bot.loadPlugin(minecrafthawkeye.default);

bot.on('spawn', function() {
    bot.chat('Spawned! Say go when ready.');
})

/** @typedef {number} EntityId */
/**
 * @typedef {CrystalInfo}
 * @property {boolean} isDestroyed;
 * @property {Entity | null | undefined} // null if out of render distance
 * @property {EntityId | undefined} entityId; // undefined if unknown
 * @property {number | undefined} endSpikeType; // undefined if unknown
 /**
  * @typedef {FireBallThreat}
  * @property {Entity} entity
  * @property {Vec3} predictedImpact
  * @property {number} predictedTime
  */


// Source: minecraft.wiki/End_spike
const hasBars = [false, true, true, false, false, false, false, false, false, false];
const spikeHeights = [76,79,82,85,88,91,94,97,100,103]
const spikeCoordinates = [
    [42, 0],
    [33, 24],
    [12, 39],
    [-13, 39],
    [-34, 24],
    [-42, -1],
    [-34, -25],
    [-13, -40],
    [12, -40],
    [33, -25]
]

/* crystal coordinates = [x+0.5, y+1, z+0.5] */

const crystals = new Array(10);
const dragon = new Set();
/** The velocity of entities is unknow until they have moved.
 * (The information is given in the add_entity packet but mineflayer does us it.)
 * @type {Set<Entity>} */
const unevaluatedFireBalls = new Set();
/** @type {Map<EntityId, FireBallThreat>} */
const fireballs = new Map();
const breaths = new Set();
const endermans = new Set();

//function classifyAllEntities() {
//    const ids = Object.keys(bot.entities)
//    for (let i=0, n=ids.length; i<n; i++) {
//        classifyEntity(ids[i]);
//    }
//}

function classifyCrystal(entity) {
    const position = entity.position;
    const x = position.x-0.5;
    const z = position.z-0.5;
    for (var i=0; i<10; i++) {
        if(x == spikeCoordinates[i][0] && z == spikeCoordinates[i][1]) break;
    }
    let j = spikeHeights.indexOf(position.y-1);
    if (i == 10 || j<0) return console.warn("Unidentified end crystal:", position);
    return crystals[i] = {
        isDestroyed: false,
        entity,
        entityId: entity.id,
        endSpikeType: j,
    }
}

function removeEndCrystalEntity(entity) {
    for (var i=0; i<10; i++) {
        if(entity == crystals[i]?.entity) return crystals[i].entity = null;
    }
    //TODO: was the crystal destroyed of left render distance?
}

bot.on('entityMoved', (entity) => {
    if (entity.name === "dragon_fireball") {
        if (unevaluatedFireBalls.has(entity)) evaluateFireBall(entity);
        return;
    }
})

function chebyshevDistance(v1, v2) {
    return Math.max(...v1.minus(v2).abs().toArray());
}

/*  */
const safeFireBallDistance = 10;

/** 
 * These are probably poorly named as their use changes as improvements are made.
 * They are named after their original purpose. The current purpose is somehow related.
 * @type {'destroyCrystals' | 'escapeBreath' | 'dragonPerched' | 'idle'}
 */
var currentMode = 'idle';

/**
 * 
 * @param {Entity} entity 
 */
function evaluateFireBall(entity) {
    if (entity.velocity.isZero()) {return console.warn("Why is there a stationary fireball?");}
    if (entity.velocity.x === undefined) return console.warn("Why is velocity undefined?");
    let result = bot.world.raycast(entity.position, entity.velocity, 200);
    if (!result) return unevaluatedFireBalls.delete(entity); // Hopefully not a threat
    /** @type {Vec3} */
    const predictedImpact = result.intersect;
    const predictedTime = predictedImpact.norm() / entity.velocity.norm();
    fireballs.set(entity.id, {
        entity,
        predictedImpact,
        predictedTime
    });
    const distance = chebyshevDistance(predictedImpact, bot.entity.position);
    if (distance < safeFireBallDistance && currentMode != 'idle') {
        setMode('escapeBreath');
    }
    //if (predictedImpact)
    unevaluatedFireBalls.delete(entity);
}
function clearFireBall(entity) {
    unevaluatedFireBalls.delete(entity);
    fireballs.delete(entity.id);
}

/**
 * There are two types of breath area effect cloud one is cause by dragon_fireball,
 * the second is blown when perched.
 * 1. Radius: 5.0 Duration: 200 Radius per tick 0.0
 * 2. Radius: 3.0 Duration: 600 Radius per tick 0.006666667
 */

/**
 * Three circles
 * inside fountain
 * far enough to not get fireball in fountain
 * close enough to reach fountain before perch
 */

const inFountainGoal = new goals.GoalNearXZ(0.5, 0.5, 3);
const outsideFountainGoal = new goals.GoalInvert(new goals.GoalNear(0, 0, safeFireBallDistance));

class GoalInFountain extends goals.GoalBlock {
    constructor(portalYLevel) { super(0,portalYLevel,0); }
    isEnd(node) {
        return this.y==node.y && Math.abs(node.x)<3 && Math.abs(node.z)<3;
    }
}

class GoalNearFountain extends goals.Goal {
    constructor(minDistance, maxDistance) {
        super();
        this.mean = (minDistance + maxDistance) / 2;
        this.minSq = minDistance * minDistance;
        this.maxSq = maxDistance * maxDistance;
    }
    heuristic (node) {
        return Math.abs(Math.sqrt(node.x*node.x + node.z*node.z) - this.mean);
    }
    isEnd (node) {
        const distanceSq = node.x*node.x + node.z*node.z;
        return distanceSq >= this.minSq && distanceSq <= this.maxSq;
    }
}
//
//
//function onEventUnlessInterupted(event, listener) {
//    function removeEventListeners() {
//        bot.removeListener('goal_reached', onGoalReached);
//        bot.removeListener('mode_changed', onModeChange);
//    }
//    function onGoalReached() {
//        removeEventListeners();
//    }
//    function onModeChanged() {
//        removeEventListeners();
//    }
//    bot.on('goal_reached', onGoalReached);
//    bot.on('mode_changed', onModeChanged);
//}

function escapeFireBalls() {
    let breathGoals = [];
    breaths.forEach((breath) => {
        const p = breath.position;
        breathGoals.push(new goals.GoalNear(p.x, p.y, p.z, safeFireBallDistance));
    });
    fireballs.values().forEach((fireball) => {
        const p = fireball.predictedImpact;
        breathGoals.push(new goals.GoalNear(p.x, p.y, p.z, safeFireBallDistance));
    });
    const toCloseToBreath = new goals.GoalCompositeAny(breathGoals);
    const safeFromBreath = new goals.GoalInvert(toCloseToBreath);
    const safeAnNearFountain = new goals.GoalCompositeAll([safeFromBreath, goalNearFountain]);
    // We can't move while using a bow
    bot.hawkEye.stop();
    bot.pathfinder.setGoal(safeAnNearFountain);
    console.log("escaping fireball");
    bot.once('goal_reached', () => {setMode('destroyCrystals');});
}
bot.on('mode_escapeBreath', escapeFireBalls);

bot.on('entitySpawn', (entity) => {
    switch (entity.name) {
        case "enderman": endermans.add(entity); break;
        case "dragon_fireball": unevaluatedFireBalls.add(entity); break;
        case "area_effect_cloud": breaths.add(entity); break;
        case "end_crystal": classifyCrystal(entity); break;
        case "ender_dragon": dragon.add(entity); break;
    }
});
bot.on('entityGone', (entity) => {
    switch (entity.name) {
        case "enderman": endermans.delete(entity); break;
        case "dragon_fireball": clearFireBall(entity); break;
        case "area_effect_cloud": breaths.delete(entity); break;
        case "end_crystal": removeEndCrystalEntity(entity); break;
        case "ender_dragon": dragon.delete(entity); break;
    }
    //console.log("gone:", entity);
});

// Dragon phases
const HOLDING_PATTERN = 0;
const STRAFE_PLAYER = 1;
const LANDING_APPROACH = 2;
const LANDING = 3;
const TAKEOFF = 4;
const SITTING_FLAMING = 5;
const SITTING_SCANNING = 6;
const SITTING_ATTACKING = 7;
const CHARGING_PLAYER = 8;
const DYING = 9;
const HOVER = 10;

const dragonPhaseIndex = 16;

bot.on("entityUpdate", entity => {
    if (!dragon.has(entity) || currentMode == 'idle') return;
    switch(entity.metadata[dragonPhaseIndex]) {
        // Theses states have no partical or audio cue. Listening to them seems like cheating.
        // HOLDING_PATTERN, STRAFE_PLAYER, LANDING_APPROACH, TAKEOFF, CHARGING_PLAYER.
        case LANDING_APPROACH:
            setMode('dragonPerched');
            break;
        case CHARGING_PLAYER:
            bot.chat("oops");
        case TAKEOFF:
            // Without a timeout the bot will jump into the dragon before the path is clear.
            setTimeout(() => {setMode('escapeBreath')}, 1000);
            
    }
});

//health = 20
//maxHealth = 20
//avoidDangerMultiplier = maxhealth/health
//
//currentTarget = 0;
/**
 * 
 * @param {currentMode} mode 
 * @returns 
 */
function setMode(mode) {
    if (mode == currentMode) return;
    else currentMode = mode;
    bot.emit('mode_changed');
    bot.emit('mode_' + mode);
}

function waitForMode(mode) {
    return new Promise ((resolve) => {
        if (mode == currentMode) return resolve();
        bot.on('mode_' + mode, resolve);
    });
}

async function destroyCrystals() {
    bot.chat("Destroying end crystals.");
    let crystalsDestroyed = 0;
    while (crystalsDestroyed < 10) {
        crystalsDestroyed = 0;
        for (let i=0; i<10; i++) {
            let target = crystals[i]?.entity;
            if (!target) {
                // TODO: Was the crystal destroyed or just unrendered?
                crystalsDestroyed += 1;
                continue;
            }
            await fireAtTarget(crystals[i]?.entity);
        }
    }
    bot.chat("Crystals destroyed.");
}

async function fireAtTarget(target) {
    let successful;
    const interuption = () => {successful = false}
    bot.on('mode_changed', interuption);
    do {
        await waitForMode ('destroyCrystals');
        bot.hawkEye.oneShot(target, "bow");
        successful = true;
        await new Promise ((resolve) => bot.once('auto_shot_stopped', resolve));
    } while (!successful);
    bot.removeListener('mode_changed', interuption);
}

let goalInFountain;
const goalNearFountain = new GoalNearFountain(10, 20);

function onDragonPerch() {
    bot.pathfinder.setGoal(goalInFountain);
    
}
bot.on('mode_dragonPerched', onDragonPerch);

bot.on('chat', (username, message) => {
    if (username == bot.username) return;
    switch (message) {
        case "go": beginDragonFight(); return;
        case "destroy the crystals": destroyCrystals(); return;
        case "in": bot.pathfinder.setGoal(goalInFountain); return;
        case "out": bot.pathfinder.setGoal(goalNearFountain); return;
        case "test": bot.pathfinder.setGoal(new goals.GoalBlock(1,62,0)); return;
        case "hello": bot.chat("Hi"); return;
    } 
});

function beginDragonFight() {
    const world = bot.world;
    const topOfFountain = world.raycast(
        new Vec3(0,100,0),
        new Vec3(0,-1,0),
        100,
        (block) => block.name == "bedrock"
    )
    if (!topOfFountain) {
        bot.chat("I cannot see the exit portal.");
        return console.error("Cannot locate end exit portal.");
    }
    goalInFountain = new GoalInFountain(topOfFountain.position.y - 3);
    destroyCrystals();
    setMode("escapeBreath");
}

//class SafetyGoal extends goals.Goal {
//    
//    /**
//     * 
//     * @param {Move} node 
//     */
//    heuristic(node) {
//        
//    }
//    /**
//     * 
//     * @param {Move} node 
//     */
//	isEnd(node) {
//        
//    }
//    /**
//     * 
//     * @returns boolean
//     */
//	hasChanged() {
//        return true; 
//    }
//	//public isValid(): boolean;
//    
//    currentPriority;
//    
//}

/**
 * When the dragon is SITTING_SCANNING it will enter TAKEOFF or CHARGING_PLAYER
 * after 100 ticks(5s).
 * After 25 ticks the dragon will enter SITTING_ATTACKING if there is a player
 * withing 20 blocks.
 */