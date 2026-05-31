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
        toggleKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key.mc_capture.toggle", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_F8, "key.categories.mc_capture"));

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
                String from = sender != null ? sender.getName() : null;
                RECORDER.recordChat(elapsed(), "chat_in", from, txt, txt.length());
            }
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
        String name = client.player != null ? client.player.getGameProfile().getName() : "unknown";
        String mc = client.getGameVersion();
        RECORDER.start(name, mc, "0.1.0", startMs, 20);
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
    }
}
