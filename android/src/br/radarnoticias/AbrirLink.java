package br.radarnoticias;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** Invisível: recebe o toque numa notícia do widget e abre o link no navegador.
 *  (Android 14 não deixa o widget usar um intent "genérico" para isso.) */
public class AbrirLink extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        String u = getIntent().getDataString();
        if (u != null && (u.startsWith("https://") || u.startsWith("http://")))
            try { startActivity(new Intent(Intent.ACTION_VIEW, getIntent().getData()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception e) { /* sem navegador */ }
        finish();
    }
}
