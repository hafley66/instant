declare function useState<T>(initial: T): [T, (next: T) => void];
declare function Signal<T>(initial: T): { $(next: T): void };
declare class BehaviorSubject<T> {
  constructor(initial: T);
  next(value: T): void;
}

const [nodes, setNodes] = useState<string[]>([]);
const nodesSignal = Signal(nodes);
const nodesSubject = new BehaviorSubject(nodes);

setNodes(["react"]);
nodesSignal.$(["signal"]);
nodesSubject.next(["subject"]);

const [query, setQuery] = useState("");
setQuery("projection-only control");
