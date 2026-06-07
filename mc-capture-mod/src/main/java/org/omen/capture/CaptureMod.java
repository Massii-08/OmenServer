package org.omen.capture;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientSendMessageEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import org.lwjgl.glfw.GLFW;
import net.fabricmc.fabric.api.event.player.AttackEntityCallback;
import net.minecraft.util.ActionResult;
import net.minecraft.entity.Entity;
import net.minecraft.entity.mob.HostileEntity;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.block.BlockState;
import net.minecraft.registry.Registries;
import java.util.HashSet;
import java.util.Set;

import java.nio.file.Files;
import java.nio.file.Path;
import java.io.OutputStream;
import java.nio.file.StandardOpenOption;

/**
 * Entrypoint client OmenCapture. Branche F8 (toggle REC), le tick (échantillonnage des
 * inputs/état) et le chat (in+out) sur le Recorder pur. Le HUD affiche l'état REC en continu
 * (consentement visible). Aucune capacité réseau : le fichier reste LOCAL (upload manuel).
 */
public class CaptureMod implements ClientModInitializer {
    public static final Recorder RECORDER = newFileRecorder();
    private static boolean consentShown = false;
    private static long startMs = 0;

    private KeyBinding toggleKey;

    // --- État de détection d'events comportementaux (1b.2), réinitialisé à chaque REC start ---
    private int lastHealth = -1;                 // -1 = pas encore échantillonné (pas de faux 'damage' au start)
    private final Set<Integer> seenMobs = new HashSet<>();
    private BlockPos breakingPos = null;         // bloc visé en cours de minage (attaque maintenue)
    private String breakingName = null;
    private int mobScanCounter = 0;              // throttle du scan d'entités (~toutes les 10 ticks)

    private static Recorder newFileRecorder() {
        return new Recorder(() -> {
            try {
                Path dir = MinecraftClient.getInstance().runDirectory.toPath().resolve("mc-capture");
                Files.createDirectories(dir);
                Path file = dir.resolve("session-" + System.currentTimeMillis() + ".jsonl");
                return Files.newOutputStream(file, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            } catch (Exception e) {
                throw new RuntimeException(e);  // → Recorder reste OFF
            }
        });
    }

    @Override
    public void onInitializeClient() {
        // MC 1.21.6+ : 4e arg de KeyBinding = KeyBinding.Category (record) ; on prend la builtin MISC.
        // ⚠️ Référence DIRECTE obligatoire — PAS de réflexion par nom yarn : loom remappe au build les
        // noms de classes/membres MC (yarn → intermediary) mais PAS les String. Un
        // Class.forName("net.minecraft.client.option.KeyBinding$Category") échoue donc au RUNTIME sur
        // un client remappé (ClassNotFoundException) → crash de l'entrypoint client. Conséquence : ce
        // code cible MC 1.21.6+ ; les jars ≤1.21.5 sont figés/committés (cf. build-all-versions.sh).
        toggleKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key.mc_capture.toggle", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_F8, KeyBinding.Category.MISC));

        RecHud.register();

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            while (toggleKey.wasPressed()) toggleRecording(client);
            if (RECORDER.isRecording() && client.player != null) sampleTick(client);
        });

        ClientSendMessageEvents.CHAT.register(message -> {
            if (RECORDER.isRecording())
                RECORDER.recordChat(elapsed(), "chat_out", null, message, message.length());
        });
        ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, params, receptionTimestamp) -> {
            if (RECORDER.isRecording()) {
                String txt = message.getString();
                // 1.21.6+ : GameProfile est un record (name()) ; on lit plutôt le nom d'émetteur
                // via params.name() (Text) — API stable de 1.20.1 à 1.21.11, évite GameProfile.
                String from = sender != null ? params.name().getString() : null;
                RECORDER.recordChat(elapsed(), "chat_in", from, txt, txt.length());
            }
        });

        // ATTACK (1b.2) : le joueur frappe une entité → event combat (contexte 'combat' de segment_clips).
        // AttackEntityCallback = API Fabric stable ; PASS = ne pas annuler l'attaque.
        AttackEntityCallback.EVENT.register((player, world, hand, entity, hitResult) -> {
            if (RECORDER.isRecording() && entity != null) {
                RECORDER.recordAttack(elapsed(), Registries.ENTITY_TYPE.getId(entity.getType()).toString());
            }
            return ActionResult.PASS;
        });
    }

    private void toggleRecording(MinecraftClient client) {
        if (RECORDER.isRecording()) {
            RECORDER.stop();
            if (client.player != null) client.player.sendMessage(net.minecraft.text.Text.literal("[OmenCapture] REC-off"), false);
            return;
        }
        if (!consentShown && client.player != null) {
            client.player.sendMessage(net.minecraft.text.Text.literal(
                "[OmenCapture] Ce mod enregistre tes inputs, deplacements et le chat pour l'entrainement de la moderation. "
                + "Rien n'est envoye automatiquement — tu choisis d'uploader. F8 = demarrer/arreter."), false);
            consentShown = true;
        }
        startMs = System.currentTimeMillis();
        // getName() (Entity → Text) est stable toutes versions ; getGameProfile().getName()
        // casse en 1.21.6+ (GameProfile devenu record → name()).
        String name = client.player != null ? client.player.getName().getString() : "unknown";
        String mc = client.getGameVersion();
        RECORDER.start(name, mc, "0.1.0", startMs, 20);
        // reset de l'état de détection d'events pour la nouvelle session (pas de faux 'damage' au start)
        lastHealth = -1; seenMobs.clear(); breakingPos = null; breakingName = null; mobScanCounter = 0;
        if (client.player != null) {
            String msg = RECORDER.isRecording() ? "[OmenCapture] ● REC" : "[OmenCapture] Echec demarrage (REC-off)";
            client.player.sendMessage(net.minecraft.text.Text.literal(msg), false);
        }
    }

    private static long elapsed() { return System.currentTimeMillis() - startMs; }

    private void sampleTick(MinecraftClient client) {
        var p = client.player;
        var opt = client.options;
        TickRecord r = new TickRecord();
        r.t = elapsed();
        r.forward = opt.forwardKey.isPressed();
        r.back = opt.backKey.isPressed();
        r.left = opt.leftKey.isPressed();
        r.right = opt.rightKey.isPressed();
        r.jump = opt.jumpKey.isPressed();
        r.sneak = opt.sneakKey.isPressed();
        r.sprint = opt.sprintKey.isPressed();
        r.attack = opt.attackKey.isPressed();
        r.use = opt.useKey.isPressed();
        r.yaw = p.getYaw();
        r.pitch = p.getPitch();
        r.x = p.getX(); r.y = p.getY(); r.z = p.getZ();
        r.vx = p.getVelocity().x; r.vy = p.getVelocity().y; r.vz = p.getVelocity().z;
        r.onGround = p.isOnGround();
        r.health = (int) p.getHealth();
        r.food = p.getHungerManager().getFoodLevel();
        r.held = p.getMainHandStack().getItem().toString();
        RECORDER.recordTick(r);

        // --- Events comportementaux dérivés du tick (client-side, APIs version-stables 1.20.1→1.21.11) ---
        // DAMAGE : chute de PV depuis le dernier tick = stimulus (pas d'event dégâts client fiable en MP).
        int hp = (int) p.getHealth();
        if (lastHealth >= 0 && hp < lastHealth) RECORDER.recordDamage(elapsed(), lastHealth - hp, hp);
        lastHealth = hp;

        // MOB_APPEAR : un hostile entre dans le rayon (~16 blocs). Scan throttlé (~0.5 s) pour le coût ;
        // seenMobs = hostiles déjà signalés (ré-apparition après éloignement = nouveau stimulus).
        if (++mobScanCounter % 10 == 0 && client.world != null) {
            Set<Integer> near = new HashSet<>();
            for (Entity e : client.world.getEntities()) {
                if (e instanceof HostileEntity && e.squaredDistanceTo(p) <= 256.0) {
                    near.add(e.getId());
                    if (!seenMobs.contains(e.getId())) {
                        RECORDER.recordMobAppear(elapsed(),
                                Registries.ENTITY_TYPE.getId(e.getType()).toString(),
                                Math.sqrt(e.squaredDistanceTo(p)));
                    }
                }
            }
            seenMobs.clear();
            seenMobs.addAll(near);
        }

        // BLOCK_BREAK : le bloc visé pendant le minage (attaque maintenue) disparaît = cassé.
        HitResult ct = client.crosshairTarget;
        if (opt.attackKey.isPressed() && ct != null && ct.getType() == HitResult.Type.BLOCK && client.world != null) {
            BlockPos bp = ((BlockHitResult) ct).getBlockPos();
            BlockState st = client.world.getBlockState(bp);
            if (!st.isAir()) { breakingPos = bp; breakingName = Registries.BLOCK.getId(st.getBlock()).toString(); }
        }
        if (breakingPos != null && client.world != null && client.world.getBlockState(breakingPos).isAir()) {
            RECORDER.recordBlockBreak(elapsed(), breakingName);
            breakingPos = null;
        }
    }
}
