import { Injectable } from '@angular/core';
import { environment } from '../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class AppModeService {
  readonly isVisualizationOnly = environment.visualizationOnly;
}
