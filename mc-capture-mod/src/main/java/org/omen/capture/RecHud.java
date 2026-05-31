package org.omen.capture;

import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.minecraft.client.MinecraftClient;

/** Overlay coin haut-gauche : "● REC" (rouge) quand on enregistre, "REC-off" (gris) sinon. */
public class RecHud {
    public static void register() {
        HudRenderCallback.EVENT.register((ctx, tickDelta) -> {
            MinecraftClient mc = MinecraftClient.getInstance();
            if (mc.options.hudHidden) return;
            boolean rec = CaptureMod.RECORDER.isRecording();
            String label = rec ? "● REC" : "REC-off";
            int color = rec ? 0xFFFF5555 : 0xFF888888;
            ctx.drawText(mc.textRenderer, label, 6, 6, color, true);
        });
    }
}
