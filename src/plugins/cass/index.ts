import { registerPlugin } from "../../plugin";
import { CassSwarmPanel } from "./1_SwarmPanel";

export function registerCassPlugin(): void {
  registerPlugin({
    id: "cass",
    panels: [{
      id: "cass-swarm",
      title: "CASS Swarm",
      icon: "♟",
      iconLabel: "CASS swarm",
      component: CassSwarmPanel,
    }],
  });
}
