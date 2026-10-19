package com.fustermicrosystems.otpchat;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

// Proteccion de pantalla de OTPChat en Android.
//  - FLAG_SECURE: el sistema no deja capturar ni grabar la ventana (sale negra) y tampoco
//    muestra su contenido en el selector de apps recientes.
//  - Android 14+: si igual se detecta una captura (por ejemplo, de otra forma), se avisa a la
//    web con el evento "otpchat:screenshot", que tapa la vista y lo avisa en el chat abierto.
public class MainActivity extends BridgeActivity {
    private Activity.ScreenCaptureCallback screenCaptureCallback;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override
    public void onStart() {
        super.onStart();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            screenCaptureCallback = this::notifyScreenshot;
            registerScreenCaptureCallback(getMainExecutor(), screenCaptureCallback);
        }
    }

    @Override
    public void onStop() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && screenCaptureCallback != null) {
            unregisterScreenCaptureCallback(screenCaptureCallback);
            screenCaptureCallback = null;
        }
        super.onStop();
    }

    private void notifyScreenshot() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript("window.dispatchEvent(new CustomEvent('otpchat:screenshot'))", null)
        );
    }
}
