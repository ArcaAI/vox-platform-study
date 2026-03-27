import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Map,
  MapControls,
  MapMarker,
  MarkerContent,
  MarkerPopup,
  MarkerTooltip,
  MarkerLabel,
  MapPopup,
  MapRoute,
} from '../../../registries/mapcn/map';

const meta = {
  title: 'Registries/Mapcn/Map',
  component: Map,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof Map>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
  render: () => (
    <div style={{ width: '100%', height: '400px' }}>
      <Map center={[0, 20]} zoom={2} />
    </div>
  ),
};

export const WithControls: Story = {
  args: {} as any,
  render: () => (
    <div style={{ width: '100%', height: '400px' }}>
      <Map center={[-73.935242, 40.73061]} zoom={12}>
        <MapControls showZoom showCompass showLocate showFullscreen />
      </Map>
    </div>
  ),
};

export const WithMarker: Story = {
  args: {} as any,
  render: () => (
    <div style={{ width: '100%', height: '400px' }}>
      <Map center={[-73.935242, 40.73061]} zoom={12}>
        <MapMarker longitude={-73.935242} latitude={40.73061}>
          <MarkerContent />
        </MapMarker>
      </Map>
    </div>
  ),
};

export const WithMarkerAndPopup: Story = {
  args: {} as any,
  render: () => (
    <div style={{ width: '100%', height: '400px' }}>
      <Map center={[-73.935242, 40.73061]} zoom={12}>
        <MapMarker longitude={-73.935242} latitude={40.73061}>
          <MarkerContent />
          <MarkerPopup closeButton>
            <div>
              <strong>New York City</strong>
              <p style={{ margin: '4px 0 0', fontSize: '13px' }}>The city that never sleeps</p>
            </div>
          </MarkerPopup>
        </MapMarker>
      </Map>
    </div>
  ),
};

export const WithMarkerTooltip: Story = {
  args: {} as any,
  render: () => (
    <div style={{ width: '100%', height: '400px' }}>
      <Map center={[-73.935242, 40.73061]} zoom={12}>
        <MapMarker longitude={-73.935242} latitude={40.73061}>
          <MarkerContent />
          <MarkerTooltip>New York City</MarkerTooltip>
        </MapMarker>
      </Map>
    </div>
  ),
};

export const WithMarkerLabel: Story = {
  args: {} as any,
  render: () => (
    <div style={{ width: '100%', height: '400px' }}>
      <Map center={[-73.935242, 40.73061]} zoom={12}>
        <MapMarker longitude={-73.935242} latitude={40.73061}>
          <MarkerContent>
            <div className="relative h-4 w-4 rounded-full border-2 border-white bg-red-500 shadow-lg" />
            <MarkerLabel position="top">NYC</MarkerLabel>
          </MarkerContent>
        </MapMarker>
      </Map>
    </div>
  ),
};

export const WithStandalonePopup: Story = {
  args: {} as any,
  render: () => (
    <div style={{ width: '100%', height: '400px' }}>
      <Map center={[2.3522, 48.8566]} zoom={12}>
        <MapPopup longitude={2.3522} latitude={48.8566} closeButton>
          <div>
            <strong>Paris</strong>
            <p style={{ margin: '4px 0 0', fontSize: '13px' }}>City of Light</p>
          </div>
        </MapPopup>
      </Map>
    </div>
  ),
};

export const WithRoute: Story = {
  args: {} as any,
  render: () => {
    const routeCoordinates: [number, number][] = [
      [-73.985428, 40.748817],
      [-73.968285, 40.761432],
      [-73.97318, 40.764356],
      [-73.981934, 40.768094],
    ];

    return (
      <div style={{ width: '100%', height: '400px' }}>
        <Map center={[-73.975, 40.758]} zoom={13}>
          <MapRoute coordinates={routeCoordinates} color="#ef4444" width={4} opacity={0.9} />
          <MapMarker longitude={routeCoordinates[0][0]} latitude={routeCoordinates[0][1]}>
            <MarkerContent>
              <div className="h-3 w-3 rounded-full border-2 border-white bg-green-500 shadow-lg" />
            </MarkerContent>
          </MapMarker>
          <MapMarker longitude={routeCoordinates[routeCoordinates.length - 1][0]} latitude={routeCoordinates[routeCoordinates.length - 1][1]}>
            <MarkerContent>
              <div className="h-3 w-3 rounded-full border-2 border-white bg-red-500 shadow-lg" />
            </MarkerContent>
          </MapMarker>
        </Map>
      </div>
    );
  },
};

export const MultipleMarkers: Story = {
  args: {} as any,
  render: () => {
    const cities = [
      { name: 'London', lng: -0.1276, lat: 51.5074 },
      { name: 'Paris', lng: 2.3522, lat: 48.8566 },
      { name: 'Berlin', lng: 13.405, lat: 52.52 },
      { name: 'Rome', lng: 12.4964, lat: 41.9028 },
      { name: 'Madrid', lng: -3.7038, lat: 40.4168 },
    ];

    return (
      <div style={{ width: '100%', height: '400px' }}>
        <Map center={[5, 48]} zoom={4}>
          {cities.map((city) => (
            <MapMarker key={city.name} longitude={city.lng} latitude={city.lat}>
              <MarkerContent />
              <MarkerTooltip>{city.name}</MarkerTooltip>
            </MapMarker>
          ))}
          <MapControls />
        </Map>
      </div>
    );
  },
};

export const DarkTheme: Story = {
  args: {} as any,
  render: () => (
    <div style={{ width: '100%', height: '400px' }}>
      <Map center={[-73.935242, 40.73061]} zoom={12} theme="dark">
        <MapMarker longitude={-73.935242} latitude={40.73061}>
          <MarkerContent />
        </MapMarker>
        <MapControls />
      </Map>
    </div>
  ),
};
