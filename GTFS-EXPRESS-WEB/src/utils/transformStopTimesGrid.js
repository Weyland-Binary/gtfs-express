const transformStopTimesToGrid = (stopTimes = [], stops = []) => {
        const grid = {};
        
        stops.forEach(stop => {
        grid[stop.stop_id] = {
            stop_name: stop.stop_name,
            times: []
        };
        });
    
        stopTimes.forEach(stopTime => {
        if (grid[stopTime.stop_id]) {
            grid[stopTime.stop_id].times.push({
            arrival_time: stopTime.arrival_time,
            departure_time: stopTime.departure_time
            });
        }
        });

    return grid;
  };
  
  export { transformStopTimesToGrid };
  