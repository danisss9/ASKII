import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
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
  IonNote,
  IonItemDivider,
} from '@ionic/angular/standalone';
import { HistoryService } from '../../services/history.service';
import type { ChatSession } from '../../models/chat';

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
IonNote,
  ],
  templateUrl: './history.page.html',
})
export class HistoryPage implements OnInit {
  sessions: ChatSession[] = [];

  constructor(
    private readonly history: HistoryService,
    private readonly router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    await this.history.load();
    this.sessions = this.history.list();
  }

  open(s: ChatSession): void {
    this.history.setActive(s.id);
    void this.router.navigateByUrl('/chat');
  }

  async remove(s: ChatSession, ev: Event): Promise<void> {
    ev.stopPropagation();
    await this.history.remove(s.id);
    this.sessions = this.history.list();
  }
}