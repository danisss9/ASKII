package dev.askii.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import dev.askii.app.plugins.AskiiBrowserPlugin;
import dev.askii.app.plugins.AskiiHttpPlugin;
import dev.askii.app.plugins.AskiiScreenPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AskiiHttpPlugin.class);
        registerPlugin(AskiiBrowserPlugin.class);
        registerPlugin(AskiiScreenPlugin.class);
        super.onCreate(savedInstanceState);
    }
}