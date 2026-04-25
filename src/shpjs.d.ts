/** Minimal type stub for shpjs (Section 4.3 build-time SHP→GeoJSON conversion). */
declare module 'shpjs' {
  interface FeatureCollection {
    type: 'FeatureCollection';
    features: Array<unknown>;
  }
  function shp(input: Buffer | ArrayBuffer): Promise<FeatureCollection | FeatureCollection[]>;
  export default shp;
}
