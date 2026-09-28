/**
    Historial de deshacer / rehacer por transacciones (como juce::UndoManager):
    cada transacción agrupa acciones que se deshacen juntas con un solo Ctrl+Z.
*/
export interface UndoableAction {
  perform(): boolean;
  undo(): boolean;
}

interface Transaction {
  name: string;
  actions: UndoableAction[];
}

export class UndoManager {
  private transactions: Transaction[] = [];
  private nextIndex = 0;              // transacciones [0, nextIndex) están hechas
  private pendingName: string | null = null;    // la próxima acción abre una transacción con este nombre
  private readonly maxTransactions: number;

  constructor(maxTransactions = 200) {
    this.maxTransactions = maxTransactions;
  }

  beginNewTransaction(name: string): void {
    this.pendingName = name;
  }

  /** Ejecuta la acción y, si funciona, la añade a la transacción actual. */
  perform(action: UndoableAction): boolean {
    if (!action.perform())
      return false;

    if (this.pendingName !== null || this.nextIndex === 0) {
      // Rehacer ya no es posible tras una acción nueva.
      this.transactions.length = this.nextIndex;
      this.transactions.push({ name: this.pendingName ?? '', actions: [] });
      this.nextIndex = this.transactions.length;
      this.pendingName = null;

      if (this.transactions.length > this.maxTransactions) {
        this.transactions.shift();
        this.nextIndex = this.transactions.length;
      }
    } else {
      this.transactions.length = this.nextIndex;
    }

    this.transactions[this.nextIndex - 1].actions.push(action);
    return true;
  }

  canUndo(): boolean { return this.nextIndex > 0; }
  canRedo(): boolean { return this.nextIndex < this.transactions.length; }

  getUndoDescription(): string { return this.canUndo() ? this.transactions[this.nextIndex - 1].name : ''; }
  getRedoDescription(): string { return this.canRedo() ? this.transactions[this.nextIndex].name : ''; }

  undo(): boolean {
    if (!this.canUndo())
      return false;

    const transaction = this.transactions[this.nextIndex - 1];

    for (let i = transaction.actions.length - 1; i >= 0; --i) {
      if (!transaction.actions[i].undo()) {
        // El historial ya no es coherente con el proyecto.
        this.clear();
        return false;
      }
    }

    --this.nextIndex;
    this.pendingName = '';
    return true;
  }

  redo(): boolean {
    if (!this.canRedo())
      return false;

    const transaction = this.transactions[this.nextIndex];

    for (const action of transaction.actions) {
      if (!action.perform()) {
        this.clear();
        return false;
      }
    }

    ++this.nextIndex;
    this.pendingName = '';
    return true;
  }

  clear(): void {
    this.transactions = [];
    this.nextIndex = 0;
    this.pendingName = null;
  }

  /** Todas las acciones del historial (para saber qué audio sigue en uso). */
  allActions(): UndoableAction[] {
    return this.transactions.flatMap(t => t.actions);
  }
}
