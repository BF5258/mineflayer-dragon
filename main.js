
import { createBot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pkg;
import minecrafthawkeye from 'minecrafthawkeye';
import mineflayerPvP from 'mineflayer-pvp';
import minecraftData from 'minecraft-data';
const mcData = minecraftData('1.21.8');
import { Vec3 } from "vec3";

/**
 * Shoutout to mineflayer, minecraftHawkEye, Fabric, and SniffCraft!
 * This wouldn't exist without them.
 */


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
bot.loadPlugin(mineflayerPvP.plugin);

bot.once('spawn', function() {
    // All the chat messages are commented out due to issue #609.
    //bot.chat('Spawned! Say go when ready.');
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
/** @type {Entity} */
let dragon;
/** The velocity of entities is unknow until they have moved.
 * (The information is given in the add_entity packet but mineflayer does us it.)
 * @type {Set<Entity>} */
const unevaluatedFireBalls = new Set();
/** @type {Map<EntityId, FireBallThreat>} */
const fireballs = new Map();
const breaths = new Set();
const endermans = new Set();

// I don't think this is needed.
// 'entitySpawn' is emited for all entities upon entering the end.
//function classifyAllEntities() {
//    const ids = Object.keys(bot.entities)
//    for (let i=0, n=ids.length; i<n; i++) {
//        classifyEntity(ids[i]);
//    }
//}

/**
 * This is more complicated than needed.
 * When it was written I thought the caged crystals
 * would need to be taken out manually
 * but minecraftHawkEye has good enough aim to hit them.
 * I chose to leave this because targeting the crystals
 * in order looks more natural than randomly jumping between them.
 */
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

// I assumed area effect clouds damage all entities inside their bounding box.
// Is this assumption correct or is Euclidean distance used?
function chebyshevDistance(v1, v2) {
    return Math.max(...v1.minus(v2).abs().toArray());
}

/*  */
const safeFireBallDistance = 10;

// Current mode -----------------------------------------------------

/**
 * @type {?Object} currentMode
 * @type {'destroyCrystals' | 'attackDragon'} currentMode.phase
 * @type {'in' | 'out'} currentMode.location
 * @type {'walking' | 'waiting' | 'attacking'} currentMode.action
 */
var currentMode = null;

function setPhase(phase) {
    if (!currentMode) return;
    stopAttacking();
    currentMode.phase = phase;
    if (currentMode.action == 'attack') resumeAttacking();
}
function setLocation(location) {
    if (!currentMode) return;
    currentMode.location = location;
    //bot.chat("moving " + location);
    updateGoal();
}
function setAction(action) {
    if (!currentMode) return;
    const previousAction = currentMode.action;
    currentMode.action = action;
    //bot.chat("action: " + action);
    if (previousAction != 'walking' && action == 'walking') {
        // bows slow our movement and mineflayer-pvp sets its own goals
        stopAttacking();
    } else if (previousAction == 'walking' && action == 'attacking') {
        resumeAttacking();
    }
}

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
    if (distance < safeFireBallDistance && currentMode) {
        updateGoal();
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
 * Stay within a disk or annulus around the fountain
 * inside fountain or
 * far enough to not get fireball in fountain and close enough to reach fountain before perch
 */
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
/** @type {GoalInFountain} */
let goalInFountain;
const goalNearFountain = new GoalNearFountain(10, 20);

function updateGoal() {
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
    const targetLocation = currentMode.location == 'in' ? goalInFountain : goalNearFountain;
    const safeAnNearFountain = new goals.GoalCompositeAll([safeFromBreath, targetLocation]);
    setAction('walking');
    bot.pathfinder.setGoal(safeAnNearFountain);
}

bot.on ('goal_reached', () => {
    setAction('attacking');
});

function stopAttacking() {
    // Look up to avoid enderman.
    bot.look(bot.entity.yaw, Math.PI/2);
    switch (currentMode.phase) {
        case 'destroyCrystals': abortShot(); return;
        case 'attackDragon': stopAttackingDragon(); return;
    }
}

function resumeAttacking() {
    switch (currentMode.phase) {
        case 'destroyCrystals': beginDestroyCrystal(); return;
        case 'attackDragon': attackDragon(); return;
    }
}

function beginDestroyCrystal() {
    // Don't reload if waiting. We are about to move.
    if (currentMode.action != 'attacking') return;
    // The dragon is likely obstructing our view and flaming arrows hurt.
    if (dragonPhase == LANDING || dragonPhase >= 5 && dragonPhase <= 7) return;
    if(!nextCrystal()) return;
    const target = crystals[currentTarget]?.entity;
    if (!target) return console.error()
    //bot.chat("Attacking crystal: " + currentTarget)
    bot.hawkEye.oneShot(target, "bow");
}

function nextCrystal() {
    for (var i=0; i<10; i++) {
        currentTarget = (currentTarget+1) % 10;
        if (crystals[currentTarget]?.entity) return true;
    }
    
    //bot.chat("All crytals I can see have been destroyed.");
    setPhase('attackDragon');
    return false;
}

let shouldIgnorNextEvent = false;
bot.on('auto_shot_stopped', () => {
    if (shouldIgnorNextEvent) {
        shouldIgnorNextEvent = false;
        return;
    }
    beginDestroyCrystal();
});

function abortShot() {
    shouldIgnorNextEvent = true;
    bot.hawkEye.stop();
}

function attackDragon() {
    if (currentMode.location == 'in') {
        startHittingDragon();
        return;
    } else {
        //bot.chat("DOTO: use bow on dragon")
        // minecraftHawkEye currenly cannot hit the dragon.
        // If this is fixed we should attack the dragon with a bow.
        // bot.hawkEye.autoAttack(dragon);
        return;
    }
}
function stopAttackingDragon() {
    if (currentMode.location == 'in') {
        stopHittingDragon();
        return;
    } else {
        abortShot();
        // minecraftHawkEye currenly cannot hit the dragon.
        return;
    }
}


bot.on('entitySpawn', (entity) => {
    switch (entity.name) {
        case "enderman": endermans.add(entity); break;
        case "dragon_fireball": unevaluatedFireBalls.add(entity); break;
        case "area_effect_cloud": breaths.add(entity); break;
        case "end_crystal": classifyCrystal(entity); break;
        case "ender_dragon": dragon = entity; break;
    }
});
bot.on('entityGone', (entity) => {
    switch (entity.name) {
        case "enderman": endermans.delete(entity); break;
        case "dragon_fireball": clearFireBall(entity); break;
        case "area_effect_cloud": breaths.delete(entity); break;
        case "end_crystal": removeEndCrystalEntity(entity); break;
        case "ender_dragon": if (entity == dragon) dragon=null; break;
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
let dragonPhase;

bot.on("entityUpdate", entity => {
    if (dragon != entity || !currentMode == 'idle') return;
    dragonPhase = entity.metadata[dragonPhaseIndex];
    switch (dragonPhase) {
        // Theses states have no partical or audio cue. Listening to them seems like cheating.
        // HOLDING_PATTERN, STRAFE_PLAYER, LANDING_APPROACH, TAKEOFF, CHARGING_PLAYER.
        case LANDING_APPROACH: setLocation('in'); return;
        case CHARGING_PLAYER: //bot.chat("oops"); // Intended fall-through
        case TAKEOFF: onTakeOff(); return;
        case DYING:
            setLocation('in');
            stopAll();
            bot.chat("The end is free!");
    }
});

function onTakeOff() {
    // Prepare to move but don't move yet
    // Otherwise the bot will imediatly jump up and get hit by the dragon
    setAction('wait');
    setTimeout(setLocation, 2000, 'out');
}

let currentTarget = 0;

bot.on('chat', (username, message) => {
    if (username == bot.username) return;
    switch (message) {
        case "go": beginDragonFight(); return;
        case "stop": stopAll(); return;
    } 
});

function stopAll() {
    if (!currentMode) return;
    stopAttacking();
    currentMode = null;
}

let hitDragonInterval;

function startHittingDragon() {
    // TODO equip the highest dps when and determine attack speed.
    const sword = bot.inventory.findInventoryItem("iron_sword");
    if (sword) bot.equip(sword);
    const attackSpeed = 1.6;
    const attackInterval = 1000/attackSpeed + 50;
    hitDragonInterval = setInterval(hitDragon, attackInterval);
    // TODO calculate where the head is so we can move closer to it
    // if it is out of range.
}
function stopHittingDragon() {
    clearInterval(hitDragonInterval);
}

function hitDragon() {
    bot._client.write('use_entity', {
        target: dragon.id + 1, // +1 for head
        mouse: 1,
        sneaking: false
    });
}

function beginDragonFight() {
    bot.look(bot.entity.yaw, Math.PI/2);
    if (currentMode) {
        //bot.chat("I am already fighting the dragon.");
        return;
    }
    const world = bot.world;
    const topOfFountain = world.raycast(
        new Vec3(0,100,0),
        new Vec3(0,-1,0),
        100,
        (block) => block.name == "bedrock"
    )
    if (!topOfFountain) {
        //bot.chat("I cannot see the exit portal. I will try to get closer before initialisation.");
        bot.pathfinder.setGoal(new goals.GoalNearXZ(0, 0, 30));
        bot.once('goal_reached', beginDragonFight);
        return;
    }
    //bot.chat("Starting dragon fight.");
    goalInFountain = new GoalInFountain(topOfFountain.position.y - 3);
    currentMode = {
        phase: 'destroyCrystals',
        weapon: 'bow',
        location: 'out',
        action: 'walking'
    }
    updateGoal();
}


/**
 * When the dragon is SITTING_SCANNING it will enter TAKEOFF or CHARGING_PLAYER
 * after 100 ticks(5s).
 * After 25 ticks the dragon will enter SITTING_ATTACKING if there is a player
 * withing 20 blocks.
 */