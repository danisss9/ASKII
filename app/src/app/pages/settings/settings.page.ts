import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonList,
  IonItem,
  IonLabel,
  IonInput,
  IonSelect,
  IonSelectOption,
  IonNote,
  IonItemDivider,
} from '@ionic/angular/standalone';
import * as QRCode from 'qrcode';
import { ConfigService } from '../../services/config.service';
import { RemoteSessionService } from '../../services/remote-session.service';
import type { ProviderId } from '@shared/providers';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonInput,
    IonSelect,
    IonSelectOption,
    IonNote,
    IonItemDivider,
  ],
  templateUrl: './settings.page.html',
})
export class SettingsPage implements OnInit {
  protected readonly PROVIDERS = this.config.PLATFORMS;
  deviceName = 'Android';
  qrDataUrl = signal<string | null>(null);
  pairingError = signal<string | null>(null);

  constructor(
    protected readonly config: ConfigService,
    private readonly remote: RemoteSessionService,
  ) {}

  async ngOnInit(): Promise<void> {
    await this.config.load();
    // If already paired, regenerate the QR for display
    if (this.remote.isPaired) {
      await this.regenerateQR();
    }
  }

  providerChanged(ev: Event): void {
    const value = (ev as CustomEvent).detail.value as ProviderId;
    void this.config.setProvider(value);
  }

  setKey(provider: ProviderId, ev: Event): void {
    const value = (ev as CustomEvent).detail.value as string;
    const keys = { ...this.config.current.keys, [provider]: value };
    void this.config.save({ keys });
  }

  apiKeyChange(ev: Event): void {
    const value = (ev as CustomEvent).detail.value as string;
    void this.config.save({ apiKey: value });
  }

  urlChange(field: 'brokerUrl' | 'ollamaUrl' | 'lmStudioUrl' | 'openaiUrl', ev: Event): void {
    const value = (ev as CustomEvent).detail.value as string;
    void this.config.save({ [field]: value } as Record<typeof field, string>);
  }

  async pair(): Promise<void> {
    this.pairingError.set(null);
    try {
      await this.remote.pair(this.deviceName);
      await this.regenerateQR();
    } catch (err) {
      this.pairingError.set(err instanceof Error ? err.message : String(err));
    }
  }

  async unpair(): Promise<void> {
    await this.remote.unpair();
    this.qrDataUrl.set(null);
  }

  private async regenerateQR(): Promise<void> {
    const c = this.config.current;
    if (!c.pairingDeviceId || !c.pairingToken) {
      this.qrDataUrl.set(null);
      return;
    }
    // Encode the pairing payload as a JSON string in the QR code.
    // The controller (extension/CLI) scans this and stores the device + token.
    const payload = JSON.stringify({
      deviceId: c.pairingDeviceId,
      pairingToken: c.pairingToken,
      brokerUrl: c.brokerUrl,
      deviceName: this.deviceName,
    });
    try {
      const dataUrl = await QRCode.toDataURL(payload, { width: 300, margin: 2 });
      this.qrDataUrl.set(dataUrl);
    } catch {
      this.qrDataUrl.set(null);
    }
  }
}